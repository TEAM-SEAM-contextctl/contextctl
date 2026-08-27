import {
  computeRecordSetDigest,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  openIngestionDatabase,
  serializeLocalEmbeddingAssetManifest,
  SqliteIndexPublicationStore,
  type DocumentRetrievalEmbeddingProfile,
  type LocalEmbeddingAssetManifest,
  type PublishedIndexVersion,
} from "@contextctl/ingestion-indexing";
import {
  appendCardVersion,
  approveCardVersion,
  createContextCard,
  openRegistryDatabase,
  SqliteCardStore,
  withCardVersions,
  type CardVersion,
  type RetrievalScope,
} from "@contextctl/registry-lifecycle";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { runServeCommand } from "../../src/cli/serve-command.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";
import {
  buildCliRuntime,
  openRegistryOnlyRuntime,
} from "../../src/cli/runtime.js";
import { runStatus } from "../../src/cli/commands.js";
import { runDiagnosis } from "../../src/cli/doctor.js";
import {
  CARD_EMBEDDING_API_KEY_VARIABLE,
  CARD_EMBEDDING_ENDPOINT_VARIABLE,
  CARD_EMBEDDING_MODE_VARIABLE,
  CARD_EMBEDDING_PROFILE_VARIABLE,
  DOCUMENT_EMBEDDING_API_KEY_VARIABLE,
  DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE,
  DOCUMENT_EMBEDDING_MODE_VARIABLE,
  DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
  DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
} from "../../src/embedding/configuration.js";
import {
  localDocumentProfile,
  remoteCardProfile,
  remoteDocumentProfile,
} from "../embedding/fakes.js";

const STATE_NAMESPACE_ID = "state_local";
const SECURITY_DOMAIN = "local";
const SOURCE_ID = "src_01890f5c-7b1a-7100-8000-000000000001";
const OBSERVATION_ID = "obs_01890f5c-7b1a-7100-8000-000000000002";
const DOCUMENT_ID = "doc_01890f5c-7b1a-7100-8000-000000000003";
const CARD_ID = "unit_01890f5c-7b1a-7100-8000-000000000004";
const SCOPE_ID = "scope_retained_profile";
const SCOPE_VERSION = "scpv_aaaa";
const INDEX_ID = "didx_retained_profile";
const INDEX_VERSION = "idxv_aaaa";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("retained document binding startup", () => {
  it.each(["query", "serve"] as const)(
    "refuses %s before composition when an approved Scope still needs an unbound profile",
    async (surface) => {
      const home = mkdtempSync(join(tmpdir(), "contextctl-retained-startup-"));
      temporaryDirectories.push(home);
      const environment = remoteEnvironment(home);
      await seedReachableRetainedProfile(environment);

      const start =
        surface === "query"
          ? buildCliRuntime({
              environment,
              workingDirectory: home,
              diagnostics: () => {},
            })
          : runServeCommand(environment, home);

      await expect(start).rejects.toMatchObject({
        code: "retained_binding_missing",
        layer: "document",
      });
    },
  );

  it("reports the same missing retained assets from status and doctor", async () => {
    const home = mkdtempSync(join(tmpdir(), "contextctl-retained-missing-"));
    temporaryDirectories.push(home);
    const profile = localDocumentProfile("document-retained-local-v1");
    const environment = {
      ...remoteEnvironment(home),
      [DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE]: JSON.stringify([
        {
          profileId: profile.id,
          profileVersion: profile.version,
          mode: "local",
          artifactDirectory: join(home, "missing-retained-assets"),
        },
      ]),
    };
    await seedReachableRetainedProfile(environment, profile);

    const registry = openRegistryOnlyRuntime({ environment, workingDirectory: home });
    const status = await runStatus(
      registry,
      { kind: "status", json: true },
      { environment, workingDirectory: home },
    );
    registry.close();
    const statusReport = JSON.parse(status.stdout) as {
      readonly lanes: readonly { readonly lane: string; readonly detail: string }[];
    };
    const selectionAssets = statusReport.lanes.find(
      (lane) => lane.lane === "selection_assets",
    );

    const diagnosis = await runDiagnosis({ environment, workingDirectory: home });
    const assets = diagnosis.steps.find((step) => step.name === "embedding-assets");

    expect(selectionAssets?.detail).toContain(profile.id);
    expect(assets).toMatchObject({ status: "fail" });
    expect(assets?.detail).toContain(profile.id);
  });

  it("accepts valid retained assets without a managed active pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "contextctl-retained-valid-"));
    temporaryDirectories.push(home);
    const fixture = createRetainedAssets(home);
    const environment = {
      ...remoteEnvironment(home),
      [DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE]: JSON.stringify([
        {
          profileId: fixture.profile.id,
          profileVersion: fixture.profile.version,
          mode: "local",
          artifactDirectory: fixture.directory,
        },
      ]),
    };
    await seedReachableRetainedProfile(environment, fixture.profile);

    const registry = openRegistryOnlyRuntime({ environment, workingDirectory: home });
    const status = await runStatus(
      registry,
      { kind: "status", json: true },
      { environment, workingDirectory: home },
    );
    registry.close();
    const statusReport = JSON.parse(status.stdout) as {
      readonly lanes: readonly { readonly lane: string; readonly status: string }[];
    };
    const laneStatus = (lane: string) =>
      statusReport.lanes.find((candidate) => candidate.lane === lane)?.status;

    const diagnosis = await runDiagnosis({ environment, workingDirectory: home });
    const assets = diagnosis.steps.find((step) => step.name === "embedding-assets");

    expect(laneStatus("selection_assets")).toBe("ready");
    expect(assets).toMatchObject({ status: "ok" });
    expect(assets?.detail).toContain("이전 로컬 프로필 1개");
  });

  it("keeps routine retained checks shallow and reserves content hashes for doctor --deep", async () => {
    const home = mkdtempSync(join(tmpdir(), "contextctl-retained-shallow-"));
    temporaryDirectories.push(home);
    const fixture = createRetainedAssets(home);
    const environment = {
      ...remoteEnvironment(home),
      [DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE]: JSON.stringify([
        {
          profileId: fixture.profile.id,
          profileVersion: fixture.profile.version,
          mode: "local",
          artifactDirectory: fixture.directory,
        },
      ]),
    };
    await seedReachableRetainedProfile(environment, fixture.profile);
    writeFileSync(
      join(fixture.directory, "model.onnx"),
      Buffer.alloc(Buffer.byteLength("retained-model", "utf8"), 0x78),
    );

    const registry = openRegistryOnlyRuntime({ environment, workingDirectory: home });
    const status = await runStatus(
      registry,
      { kind: "status", json: true },
      { environment, workingDirectory: home },
    );
    registry.close();
    const shallow = await runDiagnosis({ environment, workingDirectory: home });
    const deep = await runDiagnosis({
      environment,
      workingDirectory: home,
      deep: true,
    });
    const statusReport = JSON.parse(status.stdout) as {
      readonly lanes: readonly { readonly lane: string; readonly status: string }[];
    };

    expect(
      statusReport.lanes.find((lane) => lane.lane === "selection_assets")
        ?.status,
    ).toBe("ready");
    expect(shallow.steps.find((step) => step.name === "embedding-assets"))
      .toMatchObject({ status: "ok" });
    expect(deep.steps.find((step) => step.name === "embedding-assets"))
      .toMatchObject({ status: "fail" });
  });

  it("fails diagnosis closed for a WAL snapshot missing its shared-memory index", async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), "contextctl-wal-source-"));
    const targetHome = mkdtempSync(join(tmpdir(), "contextctl-wal-target-"));
    temporaryDirectories.push(sourceHome, targetHome);
    const sourceEnvironment = remoteEnvironment(sourceHome);
    const sourcePaths = resolveContextctlPaths(sourceEnvironment, sourceHome);
    openRegistryDatabase({
      location: sourcePaths.registryDatabase,
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: SECURITY_DOMAIN,
    }).close();
    const writer = new DatabaseSync(sourcePaths.registryDatabase);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.exec(
      "UPDATE registry_metadata SET security_domain = 'temporary' WHERE singleton = 1",
    );
    writer.exec(
      "UPDATE registry_metadata SET security_domain = 'local' WHERE singleton = 1",
    );
    expect(existsSync(`${sourcePaths.registryDatabase}-wal`)).toBe(true);

    const targetEnvironment = remoteEnvironment(targetHome);
    const targetPaths = resolveContextctlPaths(targetEnvironment, targetHome);
    copyFileSync(sourcePaths.registryDatabase, targetPaths.registryDatabase);
    copyFileSync(
      `${sourcePaths.registryDatabase}-wal`,
      `${targetPaths.registryDatabase}-wal`,
    );
    writer.close();

    const diagnosis = await runDiagnosis({
      environment: targetEnvironment,
      workingDirectory: targetHome,
    });
    const assets = diagnosis.steps.find((step) => step.name === "embedding-assets");
    expect(assets).toMatchObject({ status: "fail" });
    expect(assets?.detail).toContain("shared-memory index");
  });
});

function remoteEnvironment(home: string) {
  return {
    CONTEXTCTL_HOME: home,
    CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
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
  };
}

async function seedReachableRetainedProfile(
  environment: Readonly<Partial<Record<string, string>>>,
  profile: DocumentRetrievalEmbeddingProfile = localDocumentProfile(
    "document-retained-local-v1",
  ),
): Promise<void> {
  const home = environment.CONTEXTCTL_HOME;
  if (home === undefined) throw new Error("CONTEXTCTL_HOME is required");
  const paths = resolveContextctlPaths(environment, home);

  const ingestion = openIngestionDatabase({
    location: paths.ingestionDatabase,
    stateNamespaceId: STATE_NAMESPACE_ID,
    securityDomain: SECURITY_DOMAIN,
  });
  try {
    await new SqliteIndexPublicationStore(ingestion).commitCurrent(
      retainedPublication(profile),
    );
  } finally {
    ingestion.close();
  }

  const registry = openRegistryDatabase({
    location: paths.registryDatabase,
    stateNamespaceId: STATE_NAMESPACE_ID,
    securityDomain: SECURITY_DOMAIN,
  });
  try {
    const cards = new SqliteCardStore(registry);
    const card = createContextCard(
      CARD_ID,
      {
        description: "과거 프로필로 게시된 관리 문서",
        representativeQuestions: ["이전 문서를 검색할 수 있나요?"],
        aliases: [],
        keywords: ["이전", "문서"],
      },
      { sensitive: false, allowedUsage: ["retrieval"] },
    );
    const version: CardVersion = {
      id: "cv_a",
      cardId: CARD_ID,
      lineage: {
        publicationId: "pub_retained_profile",
        observationId: OBSERVATION_ID,
        knowledgeUnitId: CARD_ID,
      },
      scopes: [retainedScope()],
      validationState: "validated",
      createdAt: "2026-08-27T00:00:00.000Z",
    };
    await cards.saveCard(
      withCardVersions(card, appendCardVersion(card.versions, version)),
      [],
    );
    await approveCardVersion(
      {
        cards,
        clock: { now: () => "2026-08-27T00:00:01.000Z" },
        ids: { nextId: () => "ev_retained_profile" },
      },
      CARD_ID,
      version.id,
      { decidedBy: "operator@example.test" },
    );
  } finally {
    registry.close();
  }
}

function retainedScope(): Extract<RetrievalScope, { kind: "managed_document" }> {
  return {
    kind: "managed_document",
    reference: { scopeId: SCOPE_ID, scopeVersion: SCOPE_VERSION },
    documentIndex: {
      documentIndexId: INDEX_ID,
      sourceId: SOURCE_ID,
      documentId: DOCUMENT_ID,
      indexVersion: INDEX_VERSION,
    },
    selection: { kind: "document" },
  };
}

function retainedPublication(
  profile: DocumentRetrievalEmbeddingProfile,
): PublishedIndexVersion {
  const documentIndex = retainedScope().documentIndex;
  return {
    manifest: {
      manifestSchemaVersion: 2,
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: SECURITY_DOMAIN,
      documentIndexId: INDEX_ID,
      indexVersion: INDEX_VERSION,
      sourceId: SOURCE_ID,
      observationId: OBSERVATION_ID,
      documentId: DOCUMENT_ID,
      documentSchemaVersion: 1,
      parserVersion: "1.0.0",
      normalizationPolicyVersion: "normalize-v1",
      lineagePolicyVersion: "lineage-v1",
      segmentationPolicyVersion: "semantic-unit-v1",
      chunkPolicyVersion: "managed-chunk-v1",
      textMeasureProfileVersion: "unicode-estimate-v1",
      embeddingProfile: profile,
      payloadSchemaVersion: 2,
      semanticUnitRevisions: {
        "unit_01890f5c-7b1a-7100-8000-000000000005": "urv_aaaa",
      },
      chunkRevisions: {},
      chunkBindings: {},
      recordCount: 0,
      recordSetDigest: computeRecordSetDigest({}),
      scopeRevisions: [{ scopeId: SCOPE_ID, scopeVersion: SCOPE_VERSION }],
      fallbackCounts: {},
      publishedAt: "2026-08-27T00:00:00.000Z",
    },
    documentIndex,
    scopes: [
      {
        scopeId: SCOPE_ID,
        scopeVersion: SCOPE_VERSION,
        kind: "managed_document",
        documentIndex,
        selector: { kind: "document" },
      },
    ],
    binding: {
      stateNamespaceId: STATE_NAMESPACE_ID,
      documentIndexId: INDEX_ID,
      indexVersion: INDEX_VERSION,
      connectorId: "vector.retained",
      accessHandle: "qdrant:v1:retained",
      securityDomain: SECURITY_DOMAIN,
    },
  };
}

function createRetainedAssets(home: string): {
  readonly directory: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
} {
  const directory = join(home, "retained-assets");
  mkdirSync(directory, { recursive: true });
  const model = Buffer.from("retained-model", "utf8");
  const config = Buffer.from("{}\n", "utf8");
  const manifest: LocalEmbeddingAssetManifest = {
    schemaVersion: 1,
    repository: "fixture/retained-model",
    revision: "fixture-revision",
    license: "Apache-2.0",
    files: [
      { path: "config.json", bytes: config.length, sha256: sha256(config) },
      { path: "model.onnx", bytes: model.length, sha256: sha256(model) },
    ],
  };
  const serialized = serializeLocalEmbeddingAssetManifest(manifest);
  writeFileSync(join(directory, "config.json"), config);
  writeFileSync(join(directory, "model.onnx"), model);
  writeFileSync(join(directory, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE), serialized);
  return {
    directory,
    profile: {
      id: "document-retained-local-v1",
      version: "1",
      model: "fixture/source-model",
      modelRevision: "source-revision",
      dimensions: 3,
      distance: "cosine",
      maxInputTokens: 480,
      textMeasureProfileVersion: "unicode-estimate-v1",
      pooling: "cls",
      normalization: "l2",
      documentInputTransformVersion: "identity-v1",
      queryInputTransformVersion: "identity-v1",
      modelMaxTokens: 512,
      admissionLimit: {
        textMeasureProfileVersion: "unicode-estimate-v1",
        maxUnits: 480,
      },
      execution: {
        kind: "local",
        adapter: "transformers-js-onnx",
        adapterVersion: "4.2.0",
        artifactRepository: manifest.repository,
        artifactRevision: manifest.revision,
        artifactPath: "model.onnx",
        artifactSha256: sha256(model),
        assetManifestSha256: sha256(Buffer.from(serialized.trim(), "utf8")),
        precision: "fp32",
      },
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
