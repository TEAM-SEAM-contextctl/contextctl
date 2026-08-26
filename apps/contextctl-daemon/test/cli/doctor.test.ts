import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  LOCAL_EMBEDDING_ACTIVE_POINTER_FILE,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  openIngestionDatabase,
  serializeLocalEmbeddingAssetManifest,
} from "@contextctl/ingestion-indexing";
import { openRegistryDatabase } from "@contextctl/registry-lifecycle";
import { afterEach, describe, expect, it } from "vitest";

import {
  runDiagnosis,
  type DiagnosisReport,
  type DiagnosisStep,
} from "../../src/cli/doctor.js";
import { addSource, writeSourcesFile, SOURCES_FILE_VERSION } from "../../src/cli/sources-file.js";
import {
  CARD_EMBEDDING_API_KEY_VARIABLE,
  CARD_EMBEDDING_ENDPOINT_VARIABLE,
  CARD_EMBEDDING_MODE_VARIABLE,
  CARD_EMBEDDING_PROFILE_VARIABLE,
  DOCUMENT_EMBEDDING_API_KEY_VARIABLE,
  DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE,
  DOCUMENT_EMBEDDING_MODE_VARIABLE,
  DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
} from "../../src/embedding/configuration.js";
import {
  remoteCardProfile,
  remoteDocumentProfile,
} from "../embedding/fakes.js";

/**
 * `contextctl doctor`, exercised against a real filesystem and nothing else.
 *
 * Two things are under test and they pull in opposite directions. The first is
 * that every check reports the truth. The second is that the artifact check
 * does *not* read ~390MB to do it — and that one cannot be asserted by reading
 * the implementation, because a shallow check and a deep one agree on every
 * input except one: a directory whose files have the right names and the right
 * lengths and the wrong contents. Every asset test below builds exactly that
 * directory, so `ok` from the default mode is positive evidence that no byte
 * was hashed, and `fail` from `--deep` on the same directory is evidence that
 * the deep mode is real rather than a synonym.
 *
 * The fake install is sparse. `truncate` records a length without allocating
 * blocks, so the "390MB" model file costs zero bytes of disk and about a
 * millisecond to create; `stat` still reports the declared size, which is
 * precisely what the shallow check reads.
 */

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function makeHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-doctor-"));
  directories.push(directory);
  return directory;
}

function assetRoot(home: string): string {
  return join(home, "embedding-assets");
}

function revisionRoot(home: string): string {
  return join(
    assetRoot(home),
    "revisions",
    DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  );
}

/**
 * An install that passes every check the shallow path makes and fails every
 * check the deep path makes: correct pointer, correct file names, correct
 * lengths, contents that are all zero bytes.
 */
async function installFakeAssets(home: string): Promise<string> {
  const revision = revisionRoot(home);
  for (const file of DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files) {
    const path = join(revision, file.path);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "w");
    try {
      // Sparse: no blocks are allocated, and `stat().size` is the declared
      // length. Writing the real 390MB would make this suite unrunnable.
      await handle.truncate(file.bytes);
    } finally {
      await handle.close();
    }
  }
  // Written so that `--deep` gets past the manifest check and fails on the one
  // thing under test — a content digest — rather than on a missing file.
  await writeFile(
    join(revision, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE),
    serializeLocalEmbeddingAssetManifest(DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST),
  );
  await writePointer(home, {
    schemaVersion: 1,
    manifestSha256: DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    revisionDirectory: `revisions/${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256}`,
  });
  return revision;
}

async function writePointer(home: string, pointer: unknown): Promise<void> {
  await mkdir(assetRoot(home), { recursive: true });
  await writeFile(
    join(assetRoot(home), LOCAL_EMBEDDING_ACTIVE_POINTER_FILE),
    typeof pointer === "string" ? pointer : `${JSON.stringify(pointer)}\n`,
  );
}

function stepNamed(report: DiagnosisReport, name: string): DiagnosisStep {
  const step = report.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`no such step: ${name}`);
  return step;
}

/** The environment of a fully configured install: durable index, no LLM. */
function healthyEnvironment(home: string): Record<string, string> {
  return {
    CONTEXTCTL_HOME: home,
    CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
  };
}

async function writeOneSource(home: string): Promise<void> {
  await writeSourcesFile(
    join(home, "sources.json"),
    addSource(
      { version: SOURCES_FILE_VERSION, sources: {} },
      { reference: "source.docs", path: join(home, "docs.md") },
    ),
  );
}

function initializeState(
  home: string,
  stateNamespaceId = "state_local",
  securityDomain = "local",
): void {
  openRegistryDatabase({
    location: join(home, "registry.db"),
    stateNamespaceId,
    securityDomain,
  }).close();
  openIngestionDatabase({
    location: join(home, "ingestion.db"),
    stateNamespaceId,
    securityDomain,
  }).close();
}

describe("runDiagnosis / embedding assets", () => {
  it("does not require a local install when both layers are remote", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: {
        CONTEXTCTL_HOME: home,
        [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
        [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]:
          "https://documents.example/v1/embeddings",
        [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: "document-secret",
        [DOCUMENT_EMBEDDING_PROFILE_VARIABLE]: JSON.stringify(
          remoteDocumentProfile(),
        ),
        [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
        [CARD_EMBEDDING_ENDPOINT_VARIABLE]:
          "https://cards.example/v1/embeddings",
        [CARD_EMBEDDING_API_KEY_VARIABLE]: "card-secret",
        [CARD_EMBEDDING_PROFILE_VARIABLE]: JSON.stringify(remoteCardProfile()),
      },
    });

    const step = stepNamed(report, "embedding-assets");
    expect(step.status).toBe("ok");
    expect(step.detail).toContain("필요하지 않습니다");
  });

  it("fails on a fresh home and names the command that fixes it", async () => {
    const home = await makeHome();

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });
    const step = stepNamed(report, "embedding-assets");

    expect(step.status).toBe("fail");
    expect(step.remedy).toContain("contextctl install-assets");
    expect(report.healthy).toBe(false);
  });

  it("passes an install whose contents are wrong, proving it hashes nothing", async () => {
    // Every file has the manifest's name and the manifest's length, and every
    // byte is zero. A check that read the bytes would fail here; `ok` is the
    // assertion that none were read.
    const home = await makeHome();
    await installFakeAssets(home);

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });

    expect(stepNamed(report, "embedding-assets").status).toBe("ok");
  });

  it("fails the same install under --deep, where the digests are checked", async () => {
    const home = await makeHome();
    await installFakeAssets(home);

    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home },
      deep: true,
    });
    const step = stepNamed(report, "embedding-assets");

    expect(step.status).toBe("fail");
    expect(step.remedy).toContain("contextctl install-assets");
  });

  it("treats an unusable pointer as 'not installed' rather than raising", async () => {
    for (const pointer of ["{not json", "", "[]", "null", '{"schemaVersion":1}']) {
      const home = await makeHome();
      await installFakeAssets(home);
      await writePointer(home, pointer);

      const report = await runDiagnosis({
        environment: { CONTEXTCTL_HOME: home },
      });

      expect(stepNamed(report, "embedding-assets").status).toBe("fail");
    }
  });

  it("fails when the pointer names a different revision", async () => {
    const home = await makeHome();
    await installFakeAssets(home);
    await writePointer(home, {
      schemaVersion: 1,
      manifestSha256: "0".repeat(64),
      revisionDirectory: `revisions/${"0".repeat(64)}`,
    });

    const step = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "embedding-assets",
    );

    expect(step.status).toBe("fail");
    expect(step.detail).toContain("0".repeat(64));
  });

  it("fails when one declared file is missing", async () => {
    const home = await makeHome();
    const revision = await installFakeAssets(home);
    await rm(join(revision, "tokenizer.json"));

    const step = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "embedding-assets",
    );

    expect(step.status).toBe("fail");
    expect(step.detail).toContain("tokenizer.json");
  });

  it("fails when a file is one byte off, which is what truncation looks like", async () => {
    const home = await makeHome();
    const revision = await installFakeAssets(home);
    const config = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files[0];
    if (config === undefined) throw new Error("manifest is empty");
    await truncate(join(revision, config.path), config.bytes - 1);

    const step = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "embedding-assets",
    );

    expect(step.status).toBe("fail");
    expect(step.detail).toContain(config.path);
  });
});

describe("runDiagnosis / sources", () => {
  it("warns but stays healthy when nothing is registered yet", async () => {
    const home = await makeHome();
    await installFakeAssets(home);

    const report = await runDiagnosis({ environment: healthyEnvironment(home) });
    const step = stepNamed(report, "sources-file");

    expect(step.status).toBe("warn");
    expect(step.remedy).toContain("contextctl source add");
    // An empty registration file is the correct state of a fresh install.
    expect(report.healthy).toBe(true);
  });

  it("reports the count when Sources are registered", async () => {
    const home = await makeHome();
    await installFakeAssets(home);
    await writeOneSource(home);

    const step = stepNamed(
      await runDiagnosis({ environment: healthyEnvironment(home) }),
      "sources-file",
    );

    expect(step.status).toBe("ok");
    expect(step.detail).toContain("Source 1개");
  });

  it("fails with the error code when the file was hand-edited into garbage", async () => {
    const home = await makeHome();
    await writeFile(join(home, "sources.json"), "{ not json");

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });
    const step = stepNamed(report, "sources-file");

    expect(step.status).toBe("fail");
    expect(step.detail).toContain("malformed");
    expect(report.healthy).toBe(false);
  });
});

describe("runDiagnosis / backends", () => {
  it("fails without Qdrant and does not dial a configured endpoint", async () => {
    const home = await makeHome();

    const missing = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "vector-backend",
    );
    expect(missing.status).toBe("fail");
    expect(missing.remedy).toContain("CONTEXTCTL_QDRANT_URL");

    // No server is listening on 6333 in CI. `ok` here is the assertion that no
    // connection was attempted — a dial would have to either hang or fail.
    const durable = stepNamed(
      await runDiagnosis({
        environment: {
          CONTEXTCTL_HOME: home,
          CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
        },
      }),
      "vector-backend",
    );
    expect(durable.status).toBe("ok");
    expect(durable.detail).toContain("6333");
  });

  it("fails on a vector endpoint the adapter refuses", async () => {
    const home = await makeHome();

    const step = stepNamed(
      await runDiagnosis({
        environment: {
          CONTEXTCTL_HOME: home,
          CONTEXTCTL_QDRANT_URL: "http://vectors.example.com",
        },
      }),
      "vector-backend",
    );

    expect(step.status).toBe("fail");
  });

  it("accepts the deterministic default, warns only on a half-configured model", async () => {
    const home = await makeHome();

    const unset = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "card-meaning",
    );
    expect(unset.status).toBe("ok");

    const partial = stepNamed(
      await runDiagnosis({
        environment: {
          CONTEXTCTL_HOME: home,
          CONTEXTCTL_CARD_MEANING_MODEL: "gpt-4o-mini",
        },
      }),
      "card-meaning",
    );
    expect(partial.status).toBe("warn");

    const full = stepNamed(
      await runDiagnosis({
        environment: {
          CONTEXTCTL_HOME: home,
          // The root, not `/v1`: the adapter appends the version path itself,
            // and a base URL already carrying it is now a warning of its own.
            CONTEXTCTL_CARD_MEANING_BASE_URL: "https://api.example.com",
          CONTEXTCTL_CARD_MEANING_MODEL: "gpt-4o-mini",
          CONTEXTCTL_CARD_MEANING_API_KEY: "sk-not-a-real-key",
        },
      }),
      "card-meaning",
    );
    expect(full.status).toBe("ok");
    expect(full.detail).toContain("gpt-4o-mini");
  });

  it("fails on a malformed tuning value rather than silently defaulting", async () => {
    const home = await makeHome();

    const step = stepNamed(
      await runDiagnosis({
        environment: {
          CONTEXTCTL_HOME: home,
          CONTEXTCTL_CARD_MEANING_TIMEOUT_MS: "30s",
        },
      }),
      "card-meaning",
    );

    expect(step.status).toBe("fail");
  });

  it("never lets the API key reach the report, in any field", async () => {
    const home = await makeHome();
    const secret = "sk-super-secret";

    // Serialized whole rather than field by field: the report is printed as a
    // unit, so a leak into any future field is a leak.
    for (const environment of [
      { CONTEXTCTL_HOME: home, CONTEXTCTL_CARD_MEANING_API_KEY: secret },
      {
        CONTEXTCTL_HOME: home,
        CONTEXTCTL_CARD_MEANING_API_KEY: secret,
        CONTEXTCTL_CARD_MEANING_BASE_URL: "https://api.example.com/v1",
        CONTEXTCTL_CARD_MEANING_MODEL: "gpt-4o-mini",
      },
      {
        CONTEXTCTL_HOME: home,
        CONTEXTCTL_CARD_MEANING_API_KEY: secret,
        CONTEXTCTL_CARD_MEANING_BASE_URL: "https://api.example.com/v1",
        CONTEXTCTL_CARD_MEANING_MODEL: "gpt-4o-mini",
        CONTEXTCTL_CARD_MEANING_TIMEOUT_MS: secret,
      },
    ]) {
      const report = await runDiagnosis({ environment });

      expect(JSON.stringify(report)).not.toContain(secret);
    }
  });
});

describe("runDiagnosis / report", () => {
  it("reports every step in a fixed order", async () => {
    const home = await makeHome();

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });

    expect(report.steps.map((step) => step.name)).toEqual([
      "node-version",
      "home-directory",
      "sources-file",
      "registry-database",
      "ingestion-database",
      "embedding-assets",
      "vector-backend",
      "card-meaning",
      "policy-context",
    ]);
  });

  it("is healthy only when nothing failed", async () => {
    const home = await makeHome();
    await installFakeAssets(home);
    await writeOneSource(home);
    initializeState(home);

    const everything = await runDiagnosis({
      environment: healthyEnvironment(home),
    });
    expect(everything.steps.map((step) => step.status)).not.toContain("fail");
    expect(everything.steps.map((step) => step.status)).not.toContain("warn");
    expect(everything.healthy).toBe(true);

    // A missing durable index is a broken production composition, not a
    // degraded mode. It must flip the aggregate verdict.
    const missingQdrant = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home },
    });
    expect(missingQdrant.steps.map((step) => step.status)).toContain("fail");
    expect(missingQdrant.healthy).toBe(false);

    const broken = await runDiagnosis({
      environment: { ...healthyEnvironment(home), CONTEXTCTL_SOURCES_FILE: home },
    });
    expect(broken.steps.map((step) => step.status)).toContain("fail");
    expect(broken.healthy).toBe(false);
  });

  it("gives every non-ok step something to do next", async () => {
    const home = await makeHome();

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });

    for (const step of report.steps) {
      if (step.status === "ok") {
        // Absent, not `undefined`: `exactOptionalPropertyTypes` makes those two
        // different types, and `JSON.stringify` only drops the first.
        expect(Object.hasOwn(step, "remedy")).toBe(false);
      } else {
        expect(step.remedy).toBeTruthy();
      }
    }
  });

  it("reports missing stores without creating them, even on a repeated run", async () => {
    const home = await makeHome();

    const first = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });
    const second = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home },
      deep: true,
    });

    for (const report of [first, second]) {
      expect(stepNamed(report, "registry-database").status).toBe("warn");
      expect(stepNamed(report, "ingestion-database").status).toBe("warn");
    }
    expect(await readdir(home)).not.toContain("registry.db");
    expect(await readdir(home)).not.toContain("ingestion.db");
  });

  it("does not create a missing home directory", async () => {
    const root = await makeHome();
    const home = join(root, "not-created-by-doctor");

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });

    expect(stepNamed(report, "home-directory").status).toBe("warn");
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves compatible stores byte-for-byte unchanged", async () => {
    const home = await makeHome();
    initializeState(home);
    const registry = join(home, "registry.db");
    const ingestion = join(home, "ingestion.db");
    const beforeRegistry = await readFile(registry);
    const beforeIngestion = await readFile(ingestion);
    const beforeFiles = await readdir(home);

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } });

    expect(stepNamed(report, "registry-database").status).toBe("ok");
    expect(stepNamed(report, "ingestion-database").status).toBe("ok");
    expect(await readFile(registry)).toEqual(beforeRegistry);
    expect(await readFile(ingestion)).toEqual(beforeIngestion);
    expect(await readdir(home)).toEqual(beforeFiles);
  });

  it("reports identity mismatch without migrating either store", async () => {
    const home = await makeHome();
    initializeState(home, "state_original", "original");
    const registry = join(home, "registry.db");
    const ingestion = join(home, "ingestion.db");
    const beforeRegistry = await readFile(registry);
    const beforeIngestion = await readFile(ingestion);

    const report = await runDiagnosis({
      environment: {
        CONTEXTCTL_HOME: home,
        CONTEXTCTL_STATE_NAMESPACE_ID: "state_other",
        CONTEXTCTL_SECURITY_DOMAIN: "other",
      },
    });

    for (const name of ["registry-database", "ingestion-database"]) {
      const step = stepNamed(report, name);
      expect(step.status).toBe("fail");
      expect(step.detail).toContain("identity_mismatch");
    }
    expect(await readFile(registry)).toEqual(beforeRegistry);
    expect(await readFile(ingestion)).toEqual(beforeIngestion);
  });

  it("fails the home directory step when the path cannot be written", async () => {
    const home = await makeHome();
    // A file where a directory must be: `mkdir` cannot create it and the probe
    // cannot be written, which is what a read-only or occupied path looks like.
    const occupied = join(home, "occupied");
    await writeFile(occupied, "");

    const report = await runDiagnosis({ environment: { CONTEXTCTL_HOME: occupied } });
    const step = stepNamed(report, "home-directory");

    expect(step.status).toBe("fail");
    expect(report.healthy).toBe(false);
  });

  it("reports the Node version it is running on", async () => {
    const home = await makeHome();

    const step = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "node-version",
    );

    // The suite cannot run at all below the minimum — `node:sqlite` is what
    // the stores import — so the assertion is that the step reads the real
    // runtime rather than a constant.
    expect(step.status).toBe("ok");
    expect(step.detail).toContain(process.versions.node);
  });

  it("never reaches for the embedding runtime or the composition root", async () => {
    // Structural, because the cost of loading either is exactly what this
    // module exists to avoid: a `doctor` that assembles a runtime inherits the
    // lazy-loading blind spot it was written to cover, and a `doctor` that
    // constructs the ONNX adapter is no longer cheap enough to run on a whim.
    const source = await readFile(
      fileURLToPath(new URL("../../src/cli/doctor.ts", import.meta.url)),
      "utf8",
    );
    const body = source.replace(/\/\*\*[\s\S]*?\*\//g, "");

    expect(body).not.toContain("TransformersJsLocalEmbeddingAdapter");
    expect(body).not.toContain("createDaemonRuntime");
    expect(body).not.toContain("resolveActiveLocalEmbeddingAssets");
  });
});

describe("card-meaning reports the URL the adapter will request", () => {
  const configured = (baseUrl: string) => ({
    CONTEXTCTL_CARD_MEANING_BASE_URL: baseUrl,
    CONTEXTCTL_CARD_MEANING_MODEL: "gemma4-12b-qat",
    CONTEXTCTL_CARD_MEANING_API_KEY: "sk-super-secret",
  });

  it("shows the composed request URL rather than the configured root", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home, ...configured("https://gllm.dilato.kr") },
    });
    const step = report.steps.find((each) => each.name === "card-meaning");

    // The root alone does not tell an operator what is called. The adapter
    // appends the path privately, so the diagnosis has to compose it.
    expect(step?.status).toBe("ok");
    expect(step?.detail).toContain("https://gllm.dilato.kr/v1/chat/completions");
  });

  it("warns on a doubled version prefix even though all three are set", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home, ...configured("https://gllm.dilato.kr/v1") },
    });
    const step = report.steps.find((each) => each.name === "card-meaning");

    // A complete configuration can still be a wrong one. This check used to
    // return `ok` the moment all three variables were present, which hid the
    // one notice that says the composed endpoint is unreachable.
    expect(step?.status).toBe("warn");
    expect(step?.detail).toContain("https://gllm.dilato.kr/v1/v1/chat/completions");
    expect(step?.remedy).toBeDefined();
  });

  it("keeps the credential out of the whole report", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home, ...configured("https://gllm.dilato.kr/v1") },
    });

    expect(JSON.stringify(report)).not.toContain("sk-super-secret");
  });
});

describe("policy-context reports what the access policy will do", () => {
  it("is ok under the default and says that sensitive Cards are excluded", async () => {
    const home = await makeHome();
    const step = stepNamed(
      await runDiagnosis({ environment: { CONTEXTCTL_HOME: home } }),
      "policy-context",
    );

    expect(step.status).toBe("ok");
    expect(step.detail).toContain("제외");
    expect(step.detail).toContain("deny");
  });

  it("warns under allow and states the consequence, not only the variable", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home, CONTEXTCTL_SENSITIVE_ACCESS: "allow" },
    });
    const step = stepNamed(report, "policy-context");

    expect(step.status).toBe("warn");
    // The reader learns what happens — sensitive Cards reach queries on every
    // surface — rather than having to infer it from a variable name.
    expect(step.detail).toContain("민감");
    expect(step.detail).toContain("질의에 노출");
    expect(step.detail).toContain("MCP");
    expect(step.remedy).toContain("deny");
    // A warning, not a failure: the operator chose it. (The report as a whole
    // is not healthy in a bare home — no assets are installed — so the step's
    // own status is what this asserts.)
    expect(step.status).not.toBe("fail");
  });

  it("fails on a value the runtime will refuse to start on", async () => {
    const home = await makeHome();
    const report = await runDiagnosis({
      environment: { CONTEXTCTL_HOME: home, CONTEXTCTL_SENSITIVE_ACCESS: "Allow" },
    });
    const step = stepNamed(report, "policy-context");

    expect(step.status).toBe("fail");
    expect(step.detail).toContain("sensitive_access_invalid");
    expect(step.remedy).toContain("deny 또는 allow");
    expect(report.steps.filter((each) => each.status === "fail").map((each) => each.name)).toContain(
      "policy-context",
    );
  });
});
