import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const releaseVersion = await readReleaseVersion();
const rootLicense = await readFile(join(repositoryRoot, "LICENSE"));
const rootLicenseSha256 = sha256(rootLicense);
const productArgument = process.argv[2];
const productMode =
  productArgument === "--product-e2e" ||
  productArgument === "--product-e2e-local-matrix";
if (process.argv.length !== (productMode ? 3 : 2)) {
  throw new Error(
    "usage: node scripts/verify-release-package.mjs [--product-e2e|--product-e2e-local-matrix]",
  );
}

const workspaces = Object.freeze([
  {
    name: "@contextctl/contracts",
    directory: "packages/contracts",
    tarball: releaseTarballName("contracts"),
    entrypoint: "dist/index.js",
  },
  {
    name: "@contextctl/ingestion-indexing",
    directory: "packages/ingestion-indexing",
    tarball: releaseTarballName("ingestion-indexing"),
    entrypoint: "dist/index.js",
  },
  {
    name: "@contextctl/registry-lifecycle",
    directory: "packages/registry-lifecycle",
    tarball: releaseTarballName("registry-lifecycle"),
    entrypoint: "dist/index.js",
  },
  {
    name: "@contextctl/selection-delivery",
    directory: "packages/selection-delivery",
    tarball: releaseTarballName("selection-delivery"),
    entrypoint: "dist/index.js",
  },
  {
    name: "@contextctl/daemon",
    directory: "apps/contextctl-daemon",
    tarball: releaseTarballName("daemon"),
    entrypoint: "dist/main.js",
    bin: "bin/contextctl.mjs",
  },
]);

const forbiddenSegments = new Set([
  "docs",
  "fixtures",
  "src",
  "test",
  "tests",
]);
const forbiddenSuffixes = Object.freeze([
  ".db",
  ".db-shm",
  ".db-wal",
  ".env",
  ".key",
  ".pem",
  ".sqlite",
  ".sqlite3",
  ".tsbuildinfo",
]);
const bundledDemoDocuments = Object.freeze([
  "demo/docs/expense.md",
  "demo/docs/leave.md",
  "demo/docs/payment.md",
  "demo/docs/refund.md",
  "demo/docs/shipping.md",
]);

let temporaryRoot;
let embeddingProvider;
try {
  await assertPublicQuickstartDocumentation();
  temporaryRoot = await mkdtemp(join(tmpdir(), "contextctl-release-package-"));
  const packDirectory = join(temporaryRoot, "packages");
  const installDirectory = join(temporaryRoot, "install");
  const contextctlHome = join(temporaryRoot, "home");
  await mkdir(packDirectory, { recursive: true });

  const pack = await runNpm([
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
    ...workspaces.flatMap((workspace) => ["--workspace", workspace.name]),
  ]);
  const packed = parsePackResult(pack.stdout);
  assertPackageContents(packed);

  await runNpm([
    "install",
    "--omit",
    "dev",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDirectory,
    ...workspaces.map((workspace) => join(packDirectory, workspace.tarball)),
  ]);
  await assertInstalledPackageMetadata(installDirectory);

  const executable = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "contextctl.cmd" : "contextctl",
  );
  await access(executable);

  const commandEnvironment = {
    ...process.env,
    CONTEXTCTL_HOME: contextctlHome,
  };
  const version = await run(executable, ["--version"], commandEnvironment);
  if (version.stdout.trim() !== `contextctl ${releaseVersion}`) {
    throw new Error(`installed command reported an unexpected version: ${version.stdout.trim()}`);
  }
  const help = await run(executable, ["--help"], commandEnvironment);
  if (!help.stdout.includes("contextctl source add")) {
    throw new Error("installed command did not render its public help");
  }
  const sourceList = await run(executable, ["source", "list"], commandEnvironment);
  if (!sourceList.stdout.includes("등록된 Source가 없습니다")) {
    throw new Error("installed command did not execute a state-free operator command");
  }
  await assertInstalledDemo(executable, commandEnvironment, temporaryRoot);
  await assertClosedFailureWithoutQdrant(executable, commandEnvironment, contextctlHome);

  if (productMode) {
    embeddingProvider = await startEmbeddingProvider();
    await verifyProductMatrix({
      executable,
      temporaryRoot,
      installationRoot: installDirectory,
      provider: embeddingProvider,
      combinations:
        productArgument === "--product-e2e-local-matrix"
          ? [
              { document: "local", card: "local" },
              { document: "local", card: "remote" },
              { document: "remote", card: "local" },
            ]
          : [{ document: "remote", card: "remote" }],
    });
  }

  process.stdout.write(
    productMode
      ? `verified ${workspaces.length} release tarballs and the configured product lifecycle matrix\n`
      : `verified ${workspaces.length} release tarballs and the installed contextctl command\n`,
  );
} finally {
  await embeddingProvider?.close();
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runNpm(arguments_) {
  return await run(npmCommand, arguments_, process.env);
}

async function readReleaseVersion() {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("root package.json does not declare the integrated release version");
  }
  return manifest.version;
}

async function assertPublicQuickstartDocumentation() {
  const query = "오전 반차와 오후 반차는 연차를 얼마나 차감하나요?";
  const sourceCommand = "contextctl source add ./contextctl-demo/leave.md";
  const expectedSentence =
    "반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다.";
  const documents = [
    {
      path: "README.md",
      start: "## Five minutes",
      end: "## As an MCP server",
      cardCount: "nine pending Card versions",
    },
    {
      path: "README.ko.md",
      start: "## 5분 만에 해보기",
      end: "## MCP 로 붙이기",
      cardCount: "Card 버전 9개가 승인을 기다린다",
    },
  ];

  for (const document of documents) {
    const content = await readFile(join(repositoryRoot, document.path), "utf8");
    const start = content.indexOf(document.start);
    const end = content.indexOf(document.end, start + document.start.length);
    const section = start < 0 || end < 0 ? "" : content.slice(start, end);
    // Markdown wraps prose freely. A line break between two words must not turn
    // a correct quickstart into a failed release, so compare its meaning-bearing
    // phrases after collapsing whitespace while keeping the section boundary.
    const normalizedSection = section.replace(/\s+/gu, " ");
    if (
      section === "" ||
      !normalizedSection.includes(sourceCommand) ||
      !normalizedSection.includes(query) ||
      !normalizedSection.includes(expectedSentence) ||
      !normalizedSection.includes(document.cardCount) ||
      normalizedSection.includes("결제가 실패하면 몇 번 재시도돼?")
    ) {
      throw new Error(
        `${document.path} quickstart no longer matches the installed leave.md product flow`,
      );
    }
  }
}

function releaseTarballName(packageName) {
  return `contextctl-${packageName}-${releaseVersion}.tgz`;
}

async function run(command, arguments_, environment) {
  return await execFileAsync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON metadata");
  }
  if (Array.isArray(parsed)) {
    return new Map(parsed.map((entry) => [entry.name, entry]));
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("npm pack returned an invalid metadata shape");
  }
  return new Map(Object.entries(parsed));
}

function assertPackageContents(packed) {
  if (packed.size !== workspaces.length) {
    throw new Error(`expected ${workspaces.length} release tarballs, received ${packed.size}`);
  }
  for (const expected of workspaces) {
    const metadata = packed.get(expected.name);
    if (metadata === undefined || metadata === null || typeof metadata !== "object") {
      throw new Error(`npm pack omitted ${expected.name}`);
    }
    if (metadata.filename !== expected.tarball || !Array.isArray(metadata.files)) {
      throw new Error(`${expected.name} produced an unexpected tarball`);
    }
    if (metadata.version !== releaseVersion) {
      throw new Error(`${expected.name} is not on integrated version ${releaseVersion}`);
    }
    const paths = metadata.files.map((file) => file?.path).filter((path) => typeof path === "string");
    const requiredPaths = [
      "package.json",
      "LICENSE",
      "README.md",
      expected.entrypoint,
      expected.bin,
      ...(expected.name === "@contextctl/daemon" ? bundledDemoDocuments : []),
    ].filter(Boolean);
    for (const required of requiredPaths) {
      if (!paths.includes(required)) {
        throw new Error(`${expected.name} tarball omitted ${required}`);
      }
    }
    for (const path of paths) {
      assertSafePublishedPath(expected.name, path);
    }
  }
}

async function assertInstalledPackageMetadata(installDirectory) {
  for (const expected of workspaces) {
    const packageRoot = join(
      installDirectory,
      "node_modules",
      ...expected.name.split("/"),
    );
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    if (manifest.name !== expected.name || manifest.version !== releaseVersion) {
      throw new Error(`${expected.name} installed with unexpected identity`);
    }
    if (manifest.license !== "MIT") {
      throw new Error(`${expected.name} does not declare the MIT license`);
    }
    if (
      manifest.repository?.type !== "git" ||
      manifest.repository?.url !==
        "git+https://github.com/TEAM-SEAM-contextctl/contextctl.git" ||
      manifest.repository?.directory !== expected.directory
    ) {
      throw new Error(`${expected.name} does not identify its repository directory`);
    }
    if (
      manifest.homepage !==
        "https://github.com/TEAM-SEAM-contextctl/contextctl#readme" ||
      manifest.bugs?.url !==
        "https://github.com/TEAM-SEAM-contextctl/contextctl/issues"
    ) {
      throw new Error(`${expected.name} does not expose its project and issue URLs`);
    }
    if (manifest.engines?.node !== ">=24.18.0 <25") {
      throw new Error(`${expected.name} declares an unverified Node support range`);
    }
    if (
      typeof manifest.description !== "string" ||
      manifest.description.trim() === "" ||
      !Array.isArray(manifest.keywords) ||
      !manifest.keywords.includes("contextctl")
    ) {
      throw new Error(`${expected.name} is missing package discovery metadata`);
    }
    const packagedLicense = await readFile(join(packageRoot, "LICENSE"));
    if (sha256(packagedLicense) !== rootLicenseSha256) {
      throw new Error(`${expected.name} LICENSE differs from the repository license`);
    }
    const packagedReadme = await readFile(join(packageRoot, "README.md"), "utf8");
    if (!packagedReadme.includes(`# ${expected.name}`)) {
      throw new Error(`${expected.name} README does not identify the package`);
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafePublishedPath(packageName, path) {
  if (packageName === "@contextctl/daemon" && bundledDemoDocuments.includes(path)) {
    return;
  }
  const segments = path.split("/");
  if (
    segments.some((segment) => forbiddenSegments.has(segment)) ||
    forbiddenSuffixes.some((suffix) => path.toLowerCase().endsWith(suffix)) ||
    path.startsWith(".")
  ) {
    throw new Error(`${packageName} tarball contains a forbidden path: ${path}`);
  }
  if (
    path !== "package.json" &&
    path !== "README.md" &&
    path !== "LICENSE" &&
    path !== "bin/contextctl.mjs" &&
    !path.startsWith("dist/")
  ) {
    throw new Error(`${packageName} tarball contains an undeclared public path: ${path}`);
  }
}

async function assertInstalledDemo(executable, environment, temporaryRoot) {
  const destination = join(temporaryRoot, "installed-demo");
  const initialized = await run(executable, ["demo", "init", destination], environment);
  if (!initialized.stdout.includes("데모 문서 5개를 준비했다")) {
    throw new Error("installed command did not report the bundled demo documents");
  }
  const expectations = Object.freeze({
    "expense.md": "경비 정산 마감일은 매월 5일이며",
    "leave.md": "반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다.",
    "payment.md": "재시도 간격은 5분, 30분, 2시간입니다.",
    "refund.md": "카드는 3~5영업일, 계좌이체는 당일 처리됩니다.",
    "shipping.md": "운송장은 출고 후 2시간 이내에 발급됩니다.",
  });
  for (const [name, sentence] of Object.entries(expectations)) {
    const content = await readFile(join(destination, name), "utf8");
    if (!content.includes(sentence)) {
      throw new Error(`installed demo document is missing its expected content: ${name}`);
    }
  }
}

async function assertClosedFailureWithoutQdrant(executable, environment, contextctlHome) {
  const withoutQdrant = { ...environment };
  delete withoutQdrant.CONTEXTCTL_QDRANT_URL;
  delete withoutQdrant.CONTEXTCTL_QDRANT_API_KEY;
  let failure;
  try {
    await run(executable, ["serve"], withoutQdrant);
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error("installed daemon started without its required Qdrant binding");
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  if (!stderr.includes("qdrant_endpoint_required")) {
    throw new Error("installed daemon did not report the missing Qdrant binding");
  }
  const entries = await readdir(contextctlHome).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (entries.some((entry) => entry.endsWith(".db") || entry.includes(".db-"))) {
    throw new Error("installed daemon created durable state before refusing missing Qdrant");
  }
}

async function verifyProductMatrix(input) {
  for (const combination of input.combinations) {
    await verifyProduct({ ...input, combination });
  }
}

async function verifyProduct(input) {
  const qdrantUrl = requiredEnvironment("CONTEXTCTL_RELEASE_E2E_QDRANT_URL");
  const combinationName = `${input.combination.document}-${input.combination.card}`;
  const productHome = join(input.temporaryRoot, `product-home-${combinationName}`);
  const restoredHome = join(input.temporaryRoot, `restored-home-${combinationName}`);
  const backupDirectory = join(input.temporaryRoot, `backup-${combinationName}`);
  const demoDirectory = join(input.temporaryRoot, `demo-${combinationName}`);
  const documentPath = join(demoDirectory, "leave.md");
  const suffix = [
    input.combination.document,
    input.combination.card,
    Date.now().toString(36),
    process.pid.toString(36),
  ].join("-");
  const profileModuleRoot = join(input.installationRoot, "node_modules", "@contextctl");
  const ingestion = await import(
    fileUrl(join(profileModuleRoot, "ingestion-indexing", "dist", "index.js"))
  );
  const selection = await import(
    fileUrl(join(profileModuleRoot, "selection-delivery", "dist", "index.js"))
  );
  const profiles = productProfiles(
    ingestion,
    selection,
    suffix,
    input.combination,
  );
  const environment = {
    ...process.env,
    CONTEXTCTL_HOME: productHome,
    CONTEXTCTL_QDRANT_URL: qdrantUrl,
    CONTEXTCTL_STATE_NAMESPACE_ID: `release-e2e-${suffix}`,
    CONTEXTCTL_SECURITY_DOMAIN: `release-e2e-${suffix}`,
    CONTEXTCTL_DOCUMENT_EMBEDDING_MODE: input.combination.document,
    CONTEXTCTL_DOCUMENT_EMBEDDING_PROFILE: JSON.stringify(profiles.document),
    CONTEXTCTL_CARD_EMBEDDING_MODE: input.combination.card,
    CONTEXTCTL_CARD_EMBEDDING_PROFILE: JSON.stringify(profiles.card),
    ...(input.combination.document === "remote"
      ? {
          CONTEXTCTL_DOCUMENT_EMBEDDING_ENDPOINT:
            input.provider.documentEndpoint,
          CONTEXTCTL_DOCUMENT_EMBEDDING_API_KEY:
            input.provider.documentCredential,
        }
      : {}),
    ...(input.combination.card === "remote"
      ? {
          CONTEXTCTL_CARD_EMBEDDING_ENDPOINT: input.provider.cardEndpoint,
          CONTEXTCTL_CARD_EMBEDDING_API_KEY: input.provider.cardCredential,
        }
      : {}),
    ...(input.combination.document === "local" ||
    input.combination.card === "local"
      ? {
          CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY: requiredEnvironment(
            "CONTEXTCTL_RELEASE_E2E_ASSET_ROOT",
          ),
        }
      : {}),
    ...(process.env.CONTEXTCTL_RELEASE_E2E_QDRANT_API_KEY === undefined
      ? {}
      : {
          CONTEXTCTL_QDRANT_API_KEY:
            process.env.CONTEXTCTL_RELEASE_E2E_QDRANT_API_KEY,
        }),
  };
  if (
    input.combination.document === "remote" &&
    input.combination.card === "remote"
  ) {
    delete environment.CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY;
  }
  delete environment.CONTEXTCTL_CARD_MEANING_BASE_URL;
  delete environment.CONTEXTCTL_CARD_MEANING_MODEL;
  delete environment.CONTEXTCTL_CARD_MEANING_API_KEY;

  const originalSentence = "반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다.";
  const retainedSentence = "병가는 연간 10일까지 유급으로 사용할 수 있습니다.";
  await run(input.executable, ["demo", "init", demoDirectory], environment);

  let backupManifest;
  try {
    await run(input.executable, ["source", "add", documentPath], environment);
    await run(input.executable, ["ingest"], environment);
    const cardCount = await approveValidatedVersions(
      input.executable,
      environment,
    );
    if (cardCount !== 9) {
      throw new Error(
        `bundled leave.md produced ${cardCount} Cards; update the verified quickstart if this is intentional`,
      );
    }

    const query = "오전 반차와 오후 반차는 연차를 얼마나 차감하나요?";
    const initial = await queryContext(input.executable, environment, query);
    assertRetrieved(initial, originalSentence);
    const restarted = await queryContext(input.executable, environment, query);
    assertEquivalentResolution(initial, restarted, "CLI restart");

    const served = await resolveThroughServedTransports(
      input.executable,
      environment,
      query,
    );
    assertEquivalentResolution(initial, served.http, "HTTP");
    assertEquivalentResolution(initial, served.mcp, "MCP");

    await writeFile(
      documentPath,
      `# 인사 규정: 휴가\n\n## 병가\n\n${retainedSentence}\n`,
      "utf8",
    );
    await run(input.executable, ["ingest"], environment);
    const afterRemoval = await queryContext(input.executable, environment, query);
    if (retrievedText(afterRemoval).includes(originalSentence)) {
      throw new Error("removed source text remained reachable after a new Publication");
    }

    await run(
      input.executable,
      ["backup", "create", backupDirectory],
      environment,
    );
    backupManifest = JSON.parse(
      await readFile(join(backupDirectory, "manifest.json"), "utf8"),
    );
    await deleteBackupCollections(qdrantUrl, backupManifest);
    await run(
      input.executable,
      ["backup", "restore", backupDirectory, "--target-home", restoredHome],
      environment,
    );
    const restored = await queryContext(
      input.executable,
      { ...environment, CONTEXTCTL_HOME: restoredHome },
      query,
    );
    assertEquivalentResolution(afterRemoval, restored, "backup restore");
  } finally {
    if (backupManifest !== undefined) {
      await deleteBackupCollections(qdrantUrl, backupManifest).catch(() => undefined);
    }
  }
}

function productProfiles(ingestion, selection, suffix, combination) {
  const documentLocal = ingestion.DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  const cardLocal = selection.CARD_SELECTION_EMBEDDING_PROFILE;
  const model = `contextctl/release-e2e-${suffix}`;
  return {
    document:
      combination.document === "local"
        ? documentLocal
        : {
            ...documentLocal,
            id: `document-release-e2e-${suffix}`,
            model,
            modelRevision: `release-e2e-${suffix}`,
            pooling: "provider_defined",
            execution: {
              kind: "remote",
              adapter: "openai-compatible",
              adapterVersion: "1",
              model,
            },
          },
    card:
      combination.card === "local"
        ? cardLocal
        : {
            ...cardLocal,
            id: `card-release-e2e-${suffix}`,
            model,
            modelRevision: `release-e2e-${suffix}`,
            pooling: "provider_defined",
            execution: {
              kind: "remote",
              adapter: "openai-compatible",
              adapterVersion: "1",
              model,
            },
          },
  };
}

async function approveValidatedVersions(executable, environment) {
  const listed = JSON.parse(
    (await run(executable, ["cards", "list", "--json"], environment)).stdout,
  );
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error("ingest produced no Cards to approve");
  }
  for (const listing of listed) {
    const card = listing?.card;
    const versions = card?.versions?.versions;
    if (typeof card?.id !== "string" || !Array.isArray(versions)) continue;
    const target = [...versions]
      .reverse()
      .find(
        (version) =>
          version?.validationState === "validated" &&
          version.id !== card.versions.currentVersionId,
      );
    if (target !== undefined) {
      await run(
        executable,
        ["cards", "approve", card.id, target.id, "--by", "release-e2e"],
        environment,
      );
    }
  }
  return listed.length;
}

async function queryContext(executable, environment, query) {
  const result = await run(executable, ["query", query, "--json"], environment);
  return JSON.parse(result.stdout);
}

function assertRetrieved(resolution, sentence) {
  const text = retrievedText(resolution);
  if (!text.includes(sentence)) {
    const selected = (resolution.selection?.selected ?? [])
      .map((card) => `${card.cardId}@${card.versionId}`)
      .join(", ");
    throw new Error(
      `natural-language resolution did not return the expected document text; selected=${selected || "none"}; retrieved=${JSON.stringify(text.slice(0, 512))}`,
    );
  }
  const contexts = resolution.items
    ?.filter((item) => item?.fulfillment?.status === "fulfilled")
    .map((item) => item.fulfillment.context) ?? [];
  if (contexts.length === 0 || contexts.some((context) => context.contentTrust !== "untrusted")) {
    throw new Error("retrieved document context did not retain its untrusted marker");
  }
}

function retrievedText(resolution) {
  return (resolution.items ?? [])
    .flatMap((item) => item?.fulfillment?.context?.chunks ?? [])
    .map((chunk) => chunk.text)
    .join("\n");
}

function assertEquivalentResolution(expected, actual, surface) {
  const selected = (resolution) =>
    (resolution.selection?.selected ?? []).map((card) => `${card.cardId}@${card.versionId}`);
  if (
    JSON.stringify(selected(actual)) !== JSON.stringify(selected(expected)) ||
    retrievedText(actual) !== retrievedText(expected)
  ) {
    throw new Error(`${surface} did not preserve the CLI resolution meaning`);
  }
}

async function resolveThroughServedTransports(executable, environment, query) {
  const port = await reserveLoopbackPort();
  const child = spawn(executable, ["serve"], {
    cwd: repositoryRoot,
    env: { ...environment, CONTEXTCTL_HTTP_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const http = await waitForHttpResolution(port, query, child, () => stderr);
    const mcpLine = nextLine(child.stdout, 15_000);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "release-e2e",
        method: "tools/call",
        params: { name: "resolve_context", arguments: { query } },
      })}\n`,
    );
    const mcpEnvelope = JSON.parse(await mcpLine);
    const content = mcpEnvelope.result?.content?.[0]?.text;
    if (typeof content !== "string") {
      throw new Error("installed MCP server did not return a context payload");
    }
    return { http, mcp: JSON.parse(content) };
  } finally {
    const exited = waitForExit(child, 15_000);
    child.kill("SIGTERM");
    await exited;
  }
}

async function waitForHttpResolution(port, query, child, stderr) {
  const endpoint = `http://127.0.0.1:${port}/v1/context/resolve`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`installed daemon exited before HTTP became ready: ${stderr()}`);
    }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (response.ok) return await response.json();
    } catch {
      // The listener is not open yet. Startup includes provider readiness and a
      // complete Card candidate build, so refusal during this bounded wait is
      // expected and is not treated as a degraded success.
    }
    await delay(100);
  }
  throw new Error(`installed daemon HTTP surface did not become ready: ${stderr()}`);
}

function nextLine(stream, timeoutMs) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      rejectLine(new Error("installed MCP server did not answer in time"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      cleanup();
      resolveLine(line);
    };
    const onEnd = () => {
      cleanup();
      rejectLine(new Error("installed MCP server ended before answering"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null) {
      resolveExit();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("installed daemon did not stop within its shutdown bound"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolveExit();
      else rejectExit(new Error(`installed daemon did not finish graceful shutdown: ${code ?? signal}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  if (port === undefined) throw new Error("unable to reserve a loopback port");
  return port;
}

async function startEmbeddingProvider() {
  const documentCredential = "release-document-key";
  const cardCredential = "release-card-key";
  const server = createServer((request, response) => {
    void answerEmbeddingRequest(request, response, {
      "/document": documentCredential,
      "/card": cardCredential,
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("embedding provider did not bind a TCP port");
  }
  const base = `http://127.0.0.1:${address.port}`;
  return {
    documentEndpoint: `${base}/document`,
    cardEndpoint: `${base}/card`,
    documentCredential,
    cardCredential,
    close: async () =>
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        ),
      ),
  };
}

async function answerEmbeddingRequest(request, response, credentials) {
  const expectedCredential = credentials[request.url ?? ""];
  if (
    request.method !== "POST" ||
    expectedCredential === undefined ||
    request.headers.authorization !== `Bearer ${expectedCredential}`
  ) {
    response.writeHead(401).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("embedding request too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body.model !== "string" || !Array.isArray(body.input)) {
      throw new Error("invalid embedding request");
    }
    const payload = {
      model: body.model,
      data: body.input.map((text, index) => ({
        index,
        embedding: semanticFixtureVector(String(text), 384),
      })),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  } catch {
    response.writeHead(400).end();
  }
}

function semanticFixtureVector(text, dimensions) {
  const vector = new Array(dimensions).fill(0);
  const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  const features = [
    ...normalized.split(/[^\p{L}\p{N}]+/gu).filter(Boolean),
    ...Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) =>
      compact.slice(index, index + 2),
    ),
  ];
  for (const feature of features) {
    vector[stableHash(feature) % dimensions] += 1;
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) return [1, ...new Array(dimensions - 1).fill(0)];
  return vector.map((component) => component / norm);
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

async function deleteBackupCollections(qdrantUrl, manifest) {
  if (!Array.isArray(manifest?.qdrant)) {
    throw new Error("backup manifest did not list its Qdrant collections");
  }
  for (const artifact of manifest.qdrant) {
    if (typeof artifact?.collectionName !== "string") {
      throw new Error("backup manifest contains an invalid Qdrant collection");
    }
    const endpoint = new URL(qdrantUrl);
    if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
    const response = await fetch(
      new URL(`collections/${encodeURIComponent(artifact.collectionName)}`, endpoint),
      {
        method: "DELETE",
        ...(process.env.CONTEXTCTL_RELEASE_E2E_QDRANT_API_KEY === undefined
          ? {}
          : { headers: { "api-key": process.env.CONTEXTCTL_RELEASE_E2E_QDRANT_API_KEY } }),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`unable to remove release E2E collection: ${response.status}`);
    }
    await response.body?.cancel();
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`release product E2E requires ${name}`);
  }
  return value.trim();
}

function fileUrl(path) {
  return pathToFileURL(path).href;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
