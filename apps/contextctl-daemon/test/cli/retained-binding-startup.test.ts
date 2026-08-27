import {
  computeRecordSetDigest,
  openIngestionDatabase,
  SqliteIndexPublicationStore,
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runServeCommand } from "../../src/cli/serve-command.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";
import { buildCliRuntime } from "../../src/cli/runtime.js";
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
      retainedPublication(),
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

function retainedScope(): Extract<
  RetrievalScope,
  { kind: "managed_document" }
> {
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

function retainedPublication(): PublishedIndexVersion {
  const profile = localDocumentProfile("document-retained-local-v1");
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
