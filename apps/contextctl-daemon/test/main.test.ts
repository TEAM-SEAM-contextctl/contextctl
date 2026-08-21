import { afterEach, describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  EmbeddingProviderFault,
  InMemoryVectorIndexAdapter,
  type PublishedIndexVersion,
} from "@contextctl/ingestion-indexing";
import {
  appendCardVersion,
  createContextCard,
  promoteCardVersion,
  withCardVersions,
  type CardVersion,
  type DocumentIndexRef,
  type RetrievalScope,
} from "@contextctl/registry-lifecycle";
import {
  DeterministicCardEmbeddingAdapter,
  InMemoryCardCandidateIndexStore,
  isCardSelectionEmbeddingProfile,
  type ApprovedDocumentIndexRef,
} from "@contextctl/selection-delivery";

import { LocalCardEmbeddingAdapter } from "../src/adapters/local-card-embedding-adapter.js";
import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";
import { DaemonContextApplication } from "../src/context-application.js";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
  createDaemonRuntime,
  DEFAULT_CONNECTOR_ID,
  DEFAULT_EMBEDDING_PROFILE,
  DEFAULT_SECURITY_DOMAIN,
  DETERMINISTIC_CARD_SELECTION_PROFILE,
  readDaemonRuntimeOptions,
  readHttpPort,
  VectorBackendConfigurationError,
  type DaemonRuntime,
  type DaemonRuntimeOptions,
} from "../src/main.js";

/**
 * Every runtime a test built, so its SQLite handle can be closed.
 *
 * `createDaemonRuntime` opens a database per call, and nothing in the graph
 * closes it — the process entry point owns that in production, and a test that
 * skipped it would leak one handle per assertion.
 */
const runtimes: DaemonRuntime[] = [];

/**
 * The deterministic test composition, stated explicitly.
 *
 * An unconfigured runtime now defaults to the production profile and fails
 * closed without installed assets, so a test that wants network-free vectors
 * has to say so — which is the point of the guard being there.
 */
function buildRuntime(options: Partial<DaemonRuntimeOptions> = {}): DaemonRuntime {
  const runtime = createDaemonRuntime({
    embeddingProfile: DEFAULT_EMBEDDING_PROFILE,
    embeddingProvider: new DeterministicEmbeddingAdapter(),
    vectorIndex: new InMemoryVectorIndexAdapter(),
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()?.database.close();
  }
});

/**
 * The logical coordinates every fixture below shares.
 *
 * Typed as `ApprovedDocumentIndexRef` on purpose: that is the narrowest of the
 * three document index shapes crossing this file, so the annotation pins these
 * four fields as exactly what Selection is allowed to see, and excess property
 * checking rejects a physical field being folded back in here.
 *
 * The physical pair lives at each point of use instead, and there are only two:
 * the index catalog's `binding`, and Registry's own v1 Scope. Neither is a
 * Selection value, and neither shares an access handle with the other, so
 * naming them separately is what keeps visible which side is asserting a
 * physical store.
 */
const localDocumentIndex: ApprovedDocumentIndexRef = {
  documentIndexId: "didx_local",
  sourceId: "src_01890f5c-7b1a-7101-8000-000000000101",
  documentId: "doc_01890f5c-7b1a-7102-8000-000000000102",
  indexVersion: "idxv_aaaa",
};

/**
 * Publishes one whole-document Scope into the runtime's own publication store.
 *
 * The access handle is minted by the runtime's vector index rather than named
 * here: `InMemoryVectorIndexAdapter` derives it from the security domain and
 * the embedding profile, so a publication carrying any other handle could not
 * be rehydrated and the search would fail for a reason unrelated to wiring.
 */
async function publishWholeDocument(runtime: DaemonRuntime): Promise<void> {
  // The state namespace is part of what the handle is derived from, and the
  // search rebuilds the same compatibility out of the manifest: preparing
  // without it mints a handle for the legacy namespace that then fails to
  // rehydrate as `index_binding_invalid`.
  const prepared = await runtime.vectorIndex.prepare({
    compatibility: {
      stateNamespaceId: runtime.stateNamespaceId,
      securityDomain: runtime.securityDomain,
      embeddingProfile: runtime.embeddingProfile,
      payloadSchemaVersion: 2,
    },
    signal: new AbortController().signal,
  });
  // The catalog record's own Scope shape carries no physical binding: v2 keeps
  // `connectorId` and `accessHandle` in `binding` alone, which is now the only
  // place in this publication that names them. The approved read model
  // Selection hands the retriever names neither.
  const catalogedIndex = { ...localDocumentIndex };
  const scopes: PublishedIndexVersion["scopes"] = [
    {
      scopeId: "scope_local",
      scopeVersion: "scpv_aaaa",
      kind: "managed_document",
      documentIndex: catalogedIndex,
      selector: { kind: "document" },
    },
  ];
  const publication: PublishedIndexVersion = {
    documentIndex: catalogedIndex,
    scopes,
    binding: {
      stateNamespaceId: runtime.stateNamespaceId,
      securityDomain: runtime.securityDomain,
      documentIndexId: localDocumentIndex.documentIndexId,
      indexVersion: localDocumentIndex.indexVersion,
      // Straight from the runtime and from the handle the index just minted.
      // This is the index catalog's binding, not a Selection value: it is the
      // record Indexing resolves a managed read against, so it is the one place
      // that has to name the physical store.
      connectorId: runtime.connectorId,
      accessHandle: prepared.accessHandle,
    },
    manifest: {
      manifestSchemaVersion: 2,
      stateNamespaceId: runtime.stateNamespaceId,
      securityDomain: runtime.securityDomain,
      documentIndexId: localDocumentIndex.documentIndexId,
      indexVersion: localDocumentIndex.indexVersion,
      sourceId: localDocumentIndex.sourceId,
      observationId: "obs_01890f5c-7b1a-7103-8000-000000000103",
      documentId: localDocumentIndex.documentId,
      documentSchemaVersion: 1,
      parserVersion: "11.0.0+gfm-4.0.1",
      normalizationPolicyVersion: "markdown-normalize-v1",
      lineagePolicyVersion: "lineage-v1",
      segmentationPolicyVersion: "segmentation-v1",
      chunkPolicyVersion: "chunk-v1",
      textMeasureProfileVersion:
        runtime.embeddingProfile.textMeasureProfileVersion,
      embeddingProfile: runtime.embeddingProfile,
      payloadSchemaVersion: 2,
      semanticUnitRevisions: { "unit_01890f5c-7b1a-75ef-8967-6b51f9358f2f": "urv_aaaa" },
      chunkRevisions: { "chk_01890f5c-7b1a-74ba-89ce-0559ff8b9b01": "crv_aaaa" },
      chunkBindings: {
        "chk_01890f5c-7b1a-74ba-89ce-0559ff8b9b01": {
          chunkRevisionId: "crv_aaaa",
          semanticUnitId: "unit_01890f5c-7b1a-75ef-8967-6b51f9358f2f",
          semanticUnitRevisionId: "urv_aaaa",
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      recordCount: 1,
      recordSetDigest: `sha256:${"a".repeat(64)}`,
      scopeRevisions: [{ scopeId: "scope_local", scopeVersion: "scpv_aaaa" }],
      fallbackCounts: {},
      publishedAt: "2026-08-14T00:00:00.000Z",
    },
  };

  await runtime.publications.commitCurrent(publication);
}

/**
 * A meaning whose declared keywords appear literally in the query the tests
 * send, so scoring lands on the direct-match floor and the Card is admitted
 * under the shipped thresholds. Nothing here overrides the threshold band: a
 * fixture that needed a loosened band would prove the band, not the wiring.
 */
const admittedMeaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: [],
  keywords: ["결제", "재시도"],
};

const openPolicy = { sensitive: false, allowedUsage: ["retrieval"] };

/**
 * Approves one single-Scope Card in the runtime's own registry database.
 *
 * `runtime.cards` is the very instance `RegistryApprovedCardCatalog` wraps, so
 * a Card written here is one `resolve_context` answers from — the assembled
 * path, not a stand-in catalog. The version is promoted rather than merely
 * appended because `listApprovedCards` joins on `current_version_id`: an
 * appended-only version leaves the Card invisible, which would look exactly
 * like an empty registry and hide whatever it was meant to prove.
 */
async function approveSingleScopeCard(
  runtime: DaemonRuntime,
  cardId: string,
  versionId: string,
  scope: RetrievalScope,
): Promise<void> {
  const card = createContextCard(cardId, admittedMeaning, openPolicy);
  const version: CardVersion = {
    id: versionId,
    cardId,
    lineage: {
      publicationId: "pub_01890f5c-7b1a-7104-8000-000000000104",
      observationId: "obs_01890f5c-7b1a-7103-8000-000000000103",
      knowledgeUnitId: cardId,
    },
    scopes: [scope],
    // Anything else makes `promoteCardVersion` refuse the promotion.
    validationState: "validated",
    createdAt: "2026-08-14T00:00:00.000Z",
  };

  await runtime.cards.saveCard(
    withCardVersions(
      card,
      promoteCardVersion(appendCardVersion(card.versions, version), version.id),
    ),
    [],
  );
}

/** A Scope the daemon never reads itself, so its item is delegated. */
function sqlScope(): RetrievalScope {
  return {
    kind: "sql_source",
    reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
    connector: "postgres.main",
    schema: "public",
    table: "payments",
    columns: ["failed_reason", "status"],
  };
}

/**
 * Registry's index reference: the logical four, and nothing else.
 *
 * This fixture used to add a `connectorId` and a deliberately unmintable
 * `accessHandle` to prove nothing downstream honoured them. It cannot any more —
 * `DocumentIndexRef` has no such fields — which is the stronger version of what
 * the fixture was asserting: the physical binding is resolved from the index
 * catalog at search time and never travels with a Scope.
 */
function registryIndex(): DocumentIndexRef {
  return { ...localDocumentIndex };
}

/**
 * A Scope nothing ever published, so the search reports it and its item fails.
 *
 * The unpublished reference is the point of the fixture, not an oversight: the
 * daemon translates a Scope reference field for field and never looks a similar
 * Scope up to fill the gap, so an unpublished reference has to come back as
 * exactly that.
 */
function unpublishedDocumentScope(): RetrievalScope {
  return {
    kind: "managed_document",
    reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
    documentIndex: registryIndex(),
    selection: { kind: "document" },
  };
}

/** The Scope reference `publishWholeDocument` really commits to the catalog. */
function publishedDocumentScope(): RetrievalScope {
  return {
    kind: "managed_document",
    reference: { scopeId: "scope_local", scopeVersion: "scpv_aaaa" },
    documentIndex: registryIndex(),
    selection: { kind: "document" },
  };
}

interface ResolvedItem {
  readonly selectedBy: readonly { readonly cardId: string }[];
  readonly guide: Readonly<Record<string, unknown>>;
  readonly fulfillment: {
    readonly status: string;
    readonly executor: string;
    readonly failure?: {
      readonly stage: string;
      readonly code: string;
      readonly retriable: boolean;
    };
    readonly context?: { readonly chunks: readonly unknown[] };
  };
}

/** The state one item reached, read off a payload nothing has typed yet. */
function statusOf(item: Readonly<Record<string, unknown>>): unknown {
  return (item["fulfillment"] as Readonly<Record<string, unknown>>)["status"];
}

/** One `resolve_context` call through the surface the daemon actually serves. */
async function resolveItems(
  runtime: DaemonRuntime,
  query: string,
): Promise<readonly ResolvedItem[]> {
  const result = await callMcp(runtime, "tools/call", {
    name: "resolve_context",
    arguments: { query },
  });

  expect(result["isError"]).toBeUndefined();
  return toolPayload(result)["items"] as readonly ResolvedItem[];
}

interface JsonRpcResponse {
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Sends one request through the assembled MCP surface and returns its result. */
async function callMcp(
  runtime: DaemonRuntime,
  method: string,
  params?: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  const raw = await runtime.mcpServer.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  );
  if (raw === undefined) {
    throw new Error(`the server did not answer ${method}`);
  }
  const message = JSON.parse(raw) as JsonRpcResponse;
  if (message.result === undefined) {
    throw new Error(`expected a result for ${method}, got ${raw}`);
  }
  return message.result;
}

/** The single text block an MCP tool result carries, parsed back into a value. */
function toolPayload(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const content = result["content"] as readonly { readonly text: string }[];
  const text = content[0]?.text;
  if (text === undefined) {
    throw new Error("expected the tool result to carry one text block");
  }
  return JSON.parse(text) as Readonly<Record<string, unknown>>;
}

describe("createDaemonRuntime", () => {
  describe("port binding", () => {
    it("requires a vector index instead of selecting the test adapter", () => {
      expect(() =>
        createDaemonRuntime({} as DaemonRuntimeOptions),
      ).toThrow("an explicit vector index is required");
    });

    it("binds the catalog and the coordinator this app owns", () => {
      const runtime = buildRuntime();

      expect(runtime.catalog).toBeInstanceOf(RegistryApprovedCardCatalog);
      expect(runtime.contextApplication).toBeInstanceOf(DaemonContextApplication);
    });

    it("hands the query surfaces the application and nothing else", () => {
      const runtime = buildRuntime();

      // Neither surface can reach a catalog or a search through what it was
      // given, which is the property the split exists for. Asserted on the
      // runtime rather than on the surfaces because the surfaces keep what they
      // were built with privately — what is checkable is what was handed over.
      expect(Object.keys(runtime.contextApplication).sort()).toEqual([]);
      expect(runtime.contextApplication).not.toHaveProperty("catalog");
      expect(runtime.contextApplication).not.toHaveProperty("search");
    });

    it("applies the security domain and connector it was configured with", () => {
      const runtime = buildRuntime({
        securityDomain: "x",
        connectorId: "y",
      });

      expect(runtime.securityDomain).toBe("x");
      expect(runtime.connectorId).toBe("y");
    });

    it("refuses to assemble a production profile without installed assets", () => {
      const options = { vectorIndex: new InMemoryVectorIndexAdapter() };
      expect(() => createDaemonRuntime(options)).toThrow(EmbeddingProviderFault);
      expect(() => createDaemonRuntime(options)).toThrowError(
        expect.objectContaining({ code: "embedding_artifact_unavailable" }),
      );
    });

    it("refuses the deterministic adapter under a production profile", () => {
      expect(() =>
        createDaemonRuntime({
          vectorIndex: new InMemoryVectorIndexAdapter(),
          embeddingArtifactDirectory: "/nonexistent/assets",
          embeddingProvider: new DeterministicEmbeddingAdapter(),
        }),
      ).toThrow(TypeError);
    });

    it("binds the local adapter when an artifact directory is configured", () => {
      // Bypasses the deterministic test composition on purpose.
      const runtime = createDaemonRuntime({
        vectorIndex: new InMemoryVectorIndexAdapter(),
        embeddingArtifactDirectory: "/nonexistent/assets",
      });
      runtimes.push(runtime);

      expect(runtime.embeddingProvider.providerKind).toBe("local");
      expect(runtime.embeddingProfile.id).toBe(
        "document-granite-97m-multilingual-r2-fp32-v1",
      );
    });

    it("binds a Card vector family separate from the document one", () => {
      const runtime = createDaemonRuntime({
        vectorIndex: new InMemoryVectorIndexAdapter(),
        embeddingArtifactDirectory: "/nonexistent/assets",
      });
      runtimes.push(runtime);

      // Two ids, so the two families stay separately versionable and a Card
      // vector is never comparable against a document index by accident.
      expect(runtime.cardSelectionProfile.id).toBe(
        "card-granite-97m-multilingual-r2-fp32-v1",
      );
      expect(runtime.cardSelectionProfile.id).not.toBe(
        runtime.embeddingProfile.id,
      );
      // One artifact on disk, though: same repository, same revision, same
      // file, same digest, same precision.
      if (!isCardSelectionEmbeddingProfile(runtime.cardSelectionProfile)) {
        throw new Error("the production composition needs a pinned artifact");
      }
      const execution = runtime.cardSelectionProfile.execution;
      if (execution.kind !== "local") {
        throw new Error("the production composition needs local execution");
      }
      expect(execution.artifactPath).toBe("onnx/model.onnx");
      expect(execution.precision).toBe("fp32");
      expect(execution.artifactSha256).toBe(
        "68e592b160673d30250824c1116bc6ab33f70efb22b97c9e1d7ce1e69c1c9d70",
      );
      expect(runtime.cardSelectionProfile.dimensions).toBe(384);
      expect(runtime.cardSelectionProfile.pooling).toBe("cls");
    });

    it("serves Card vectors from the session the document path loaded", () => {
      const runtime = createDaemonRuntime({
        vectorIndex: new InMemoryVectorIndexAdapter(),
        embeddingArtifactDirectory: "/nonexistent/assets",
      });
      runtimes.push(runtime);

      // A separate port and a separate index, over one loaded model file. A
      // second local adapter would hold a second copy of identical weights.
      expect(runtime.cardEmbeddingProvider).toBeInstanceOf(
        LocalCardEmbeddingAdapter,
      );
      expect(runtime.cardEmbeddingProvider).not.toBe(runtime.embeddingProvider);
      expect(runtime.cardCandidateIndex).toBeInstanceOf(
        InMemoryCardCandidateIndexStore,
      );
    });

    it("binds the deterministic Card provider under a network-free composition", () => {
      const runtime = buildRuntime();

      // A profile that pinned an artifact while a hash adapter produced the
      // vectors would state a provenance that is simply false.
      expect(runtime.cardSelectionProfile).toEqual(
        DETERMINISTIC_CARD_SELECTION_PROFILE,
      );
      expect(isCardSelectionEmbeddingProfile(runtime.cardSelectionProfile)).toBe(
        false,
      );
      expect(runtime.cardEmbeddingProvider).toBeInstanceOf(
        DeterministicCardEmbeddingAdapter,
      );
    });

    it("refuses the deterministic Card adapter under a production Card profile", () => {
      expect(() =>
        createDaemonRuntime({
          vectorIndex: new InMemoryVectorIndexAdapter(),
          embeddingProfile: DEFAULT_EMBEDDING_PROFILE,
          embeddingProvider: new DeterministicEmbeddingAdapter(),
          cardSelectionProfile: CARD_SELECTION_EMBEDDING_PROFILE,
          cardEmbeddingProvider: new DeterministicCardEmbeddingAdapter(),
        }),
      ).toThrow(TypeError);
    });

    it("keeps one candidate index store for the whole runtime", () => {
      const runtime = buildRuntime();

      // A store per request would re-embed the whole catalog on every query.
      expect(runtime.cardCandidateIndex).toBe(runtime.cardCandidateIndex);
      expect(buildRuntime().cardCandidateIndex).not.toBe(
        runtime.cardCandidateIndex,
      );
    });

    it("falls back to the local defaults when nothing is configured", () => {
      const runtime = buildRuntime();

      expect(runtime.securityDomain).toBe(DEFAULT_SECURITY_DOMAIN);
      expect(runtime.securityDomain).toBe("local");
      expect(runtime.connectorId).toBe(DEFAULT_CONNECTOR_ID);
      expect(runtime.connectorId).toBe("vector.local");
    });
  });

  /**
   * The publication store is shared by reference, and reference identity is not
   * what these assert: the coordinator keeps its search in a private field, so
   * a runtime that handed out one instance and wired a second would still
   * satisfy `toBe`. What is asserted instead is that writing into
   * `runtime.publications` changes what the assembled surface answers.
   */
  describe("shared publication store", () => {
    it("reports a read of an unpublished Scope as failed", async () => {
      const runtime = buildRuntime();
      await approveSingleScopeCard(
        runtime,
        "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        "cv_document",
        publishedDocumentScope(),
      );

      const [item] = await resolveItems(runtime, "결제 실패 재시도");

      expect(item?.fulfillment?.status).toBe("failed");
      expect(item?.fulfillment?.failure).toEqual({
        stage: "managed_search",
        code: "scope_not_published",
        retriable: false,
      });
    });

    it("serves that read once the runtime's own store has the publication", async () => {
      const runtime = buildRuntime();
      await publishWholeDocument(runtime);
      await approveSingleScopeCard(
        runtime,
        "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        "cv_document",
        publishedDocumentScope(),
      );

      const [item] = await resolveItems(runtime, "결제 실패 재시도");

      // Empty because no vector records were written, not because anything
      // failed: reaching a fulfilled item means the coordinator translated the
      // target, the search found the publication, matched the Scope, resolved
      // the connector and the embedding provider, and searched the runtime's
      // vector index.
      expect(item?.fulfillment?.status).toBe("fulfilled");
      expect(item?.fulfillment?.context?.chunks).toEqual([]);
    });
  });

  describe("mcp surface", () => {
    it("exposes exactly one query tool", async () => {
      const runtime = buildRuntime();

      const result = await callMcp(runtime, "tools/list");

      // The catalog listing tool is gone: an agent that can enumerate every
      // approved Card can map the catalog without asking a question.
      const tools = result["tools"] as readonly { readonly name: string }[];
      expect(tools.map((tool) => tool.name)).toEqual(["resolve_context"]);
    });

    /**
     * The payload is checked by shape rather than against a hand-written key
     * list. A list of expected names only restates what the assertion's author
     * believed the contract to be; asserting the discriminated shape of `items`
     * and the *absence* of the retired keys is what would actually catch a
     * daemon still wired to the previous one.
     */
    it("answers resolve_context through the assembled ports", async () => {
      const runtime = buildRuntime();
      const query = "결제 실패 재시도";

      const result = await callMcp(runtime, "tools/call", {
        name: "resolve_context",
        arguments: { query },
      });

      expect(result["isError"]).toBeUndefined();
      const payload = toolPayload(result);

      expect(payload["query"]).toBe(query);
      const policy = payload["policy"] as Readonly<Record<string, unknown>>;
      expect(policy["payloadSchemaVersion"]).toBe(3);

      // Emptiness is the fact to assert here. What an empty catalog answers is
      // "no items", not "every item is well formed" — a per-item loop over an
      // always-empty array reads like an assertion while defending nothing, and
      // this case held one. The shape of a populated `items` is asserted where
      // there are items to shape: `resolves an approved Card's Scopes into
      // items` below.
      expect(payload["items"]).toEqual([]);

      // Absence, not `undefined`: a payload that still carried these keys with
      // an undefined value would be the previous contract, and an equality
      // check against `undefined` could not tell the two apart.
      for (const retired of [
        "evidence",
        "contracts",
        "retrievalFailures",
        "candidates",
      ]) {
        expect(Object.hasOwn(payload, retired)).toBe(false);
      }

      // An unconfigured runtime starts on an empty registry database, so a
      // summary with nothing admitted, deferred or rejected is the correct
      // answer rather than a failure.
      expect(payload["selection"]).toEqual({
        mode: "lexical_degraded",
        selected: [],
        counts: { admitted: 0, deferred: 0, rejected: 0 },
      });
    });

    /**
     * The same call as above, against a registry that actually holds Cards.
     *
     * A separate runtime rather than an extension of the previous case: the two
     * assert different things — that an empty catalog answers cleanly, and that
     * a populated one resolves through the assembled ports — and folding them
     * together would leave neither statable.
     *
     * Two Cards, on purpose. One Scope kind proves the loop runs; two prove it
     * discriminates, because `fulfillment` reaches two different values through
     * two different branches. `fulfilled` is deliberately absent: it needs the
     * publication coordinates matched exactly, and the `shared publication
     * store` cases above already prove that wiring.
     */
    it("resolves an approved Card's Scopes into items", async () => {
      const runtime = buildRuntime();
      const query = "결제 실패 재시도";
      await approveSingleScopeCard(
        runtime,
        "unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba",
        "cv_sql",
        sqlScope(),
      );
      await approveSingleScopeCard(
        runtime,
        "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        "cv_document",
        unpublishedDocumentScope(),
      );

      const result = await callMcp(runtime, "tools/call", {
        name: "resolve_context",
        arguments: { query },
      });

      expect(result["isError"]).toBeUndefined();
      const payload = toolPayload(result);
      const items = payload["items"] as readonly Readonly<
        Record<string, unknown>
      >[];

      // Asserted before anything reads an item, and asserted twice. A fixture
      // that stopped being admitted — a threshold move, a promotion that never
      // landed — would leave `items` empty, and every per-item assertion below
      // would then pass by never running. That is the exact failure this case
      // exists to make impossible.
      expect(items.length).toBeGreaterThan(0);
      expect(items).toHaveLength(2);

      // The set of states reached, not "each one is a legal state": this is
      // what shows both branches of `buildItem` ran rather than one of them
      // twice. Sorted because item order is by identity, not by fixture order.
      expect(items.map((item) => statusOf(item)).sort()).toEqual([
        "delegated",
        "failed",
      ]);

      for (const item of items) {
        expect(["fulfilled", "delegated", "failed"]).toContain(statusOf(item));
        const guide = item["guide"] as Readonly<Record<string, unknown>>;
        expect(typeof guide["kind"]).toBe("string");
      }

      // Why it failed, not merely that it did. A fixture that broke for some
      // unrelated reason — a mis-shaped access handle, a search that never
      // reached the store — would still land on `failed` and satisfy the state
      // assertion above. Only the code says the item failed for the reason
      // `unpublishedDocumentScope` was written to provoke, and it is the
      // search's own code rather than one this side invented: an
      // `unexpected_failure` here would be the fixture rotting.
      const failed = items.find((item) => statusOf(item) === "failed");
      expect(failed).toBeDefined();
      expect(
        (failed?.["selectedBy"] as readonly { readonly cardId: string }[]).map(
          (card) => card.cardId,
        ),
      ).toEqual(["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"]);
      expect(
        (failed?.["fulfillment"] as Readonly<Record<string, unknown>>)[
          "failure"
        ],
      ).toEqual({
        stage: "managed_search",
        code: "scope_not_published",
        retriable: false,
      });

      // Two Cards were approved and both answered, so the summary accounts for
      // them without naming a Card that did not.
      expect(payload["selection"]).toMatchObject({
        counts: { admitted: 2, deferred: 0, rejected: 0 },
      });
    });
  });
});

describe("readDaemonRuntimeOptions", () => {
  it("refuses an environment without the required Qdrant endpoint", () => {
    expect(() => readDaemonRuntimeOptions({})).toThrow(
      VectorBackendConfigurationError,
    );
  });

  it("reads Qdrant, the database location, security domain and connector", () => {
    const options = readDaemonRuntimeOptions({
      CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
      CONTEXTCTL_REGISTRY_DATABASE: "/tmp/cards.sqlite",
      CONTEXTCTL_SECURITY_DOMAIN: "payments",
      CONTEXTCTL_CONNECTOR_ID: "vector.remote",
    });

    expect(options).toMatchObject({
      registryDatabaseLocation: "/tmp/cards.sqlite",
      securityDomain: "payments",
      connectorId: "vector.remote",
    });
    expect(options.vectorIndex).toBeDefined();
  });

  it("treats an empty value as a value rather than as an absent setting", () => {
    const options = readDaemonRuntimeOptions({
      CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
      CONTEXTCTL_SECURITY_DOMAIN: "",
    });

    expect(Object.keys(options).sort()).toEqual(["securityDomain", "vectorIndex"]);
    expect(options.securityDomain).toBe("");
  });

  it("ignores every other variable in the environment", () => {
    expect(
      Object.keys(
        readDaemonRuntimeOptions({
          CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
          PATH: "/usr/bin",
          HOME: "/root",
        }),
      ),
    ).toEqual(["vectorIndex"]);
  });
});

describe("readHttpPort", () => {
  it("stays silent when the variable is absent or blank", () => {
    expect(readHttpPort({})).toBeUndefined();
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "" })).toBeUndefined();
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "   " })).toBeUndefined();
  });

  it("accepts a port in range", () => {
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "8080" })).toBe(8080);
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "65535" })).toBe(65_535);
  });

  it("accepts zero, which asks the operating system to choose", () => {
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "0" })).toBe(0);
  });

  it.each(["65536", "-1", "abc", "8080.5"])(
    "rejects %s",
    (raw) => {
      expect(() => readHttpPort({ CONTEXTCTL_HTTP_PORT: raw })).toThrow(
        TypeError,
      );
    },
  );

  /**
   * `Number` is what parses the value, and its tolerance is part of the
   * behaviour rather than an accident of one call site: hexadecimal literals
   * and surrounding whitespace are accepted. Pinned so that replacing the
   * parser is a visible decision.
   */
  it("inherits Number's tolerance for hex and surrounding whitespace", () => {
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: "0x1F" })).toBe(31);
    expect(readHttpPort({ CONTEXTCTL_HTTP_PORT: " 8080 " })).toBe(8080);
  });
});
