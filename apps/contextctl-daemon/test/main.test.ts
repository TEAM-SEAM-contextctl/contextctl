import { afterEach, describe, expect, it } from "vitest";

import type { PublishedIndexVersion } from "@contextctl/ingestion-indexing";
import {
  appendCardVersion,
  createContextCard,
  promoteCardVersion,
  withCardVersions,
  type CardVersion,
  type RetrievalScope,
} from "@contextctl/registry-lifecycle";
import {
  DocumentRetrievalFault,
  type ApprovedDocumentIndexRef,
  type DocumentChunkQuery,
} from "@contextctl/selection-delivery";

import { IngestionManagedDocumentRetriever } from "../src/adapters/ingestion-managed-document-retriever.js";
import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";
import {
  createDaemonRuntime,
  DEFAULT_CONNECTOR_ID,
  DEFAULT_SECURITY_DOMAIN,
  readDaemonRuntimeOptions,
  readHttpPort,
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

function buildRuntime(options?: DaemonRuntimeOptions): DaemonRuntime {
  const runtime = createDaemonRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()?.database.close();
  }
});

function documentIndexFor(
  runtime: DaemonRuntime,
  accessHandle: string,
): ApprovedDocumentIndexRef {
  return {
    documentIndexId: "didx_local",
    sourceId: "src_local",
    documentId: "doc_local",
    indexVersion: "idxv_aaaa",
    connectorId: runtime.connectorId,
    accessHandle,
  };
}

function queryFor(documentIndex: ApprovedDocumentIndexRef): DocumentChunkQuery {
  return {
    queryText: "결제 실패 재시도",
    documentIndex,
    selection: { kind: "document" },
    limit: 8,
  };
}

/**
 * Publishes one whole-document Scope into the runtime's own publication store.
 *
 * The access handle is minted by the runtime's vector index rather than named
 * here: `InMemoryVectorIndexAdapter` derives it from the security domain and
 * the embedding profile, so a publication carrying any other handle could not
 * be rehydrated and the search would fail for a reason unrelated to wiring.
 */
async function publishWholeDocument(
  runtime: DaemonRuntime,
): Promise<PublishedIndexVersion> {
  const prepared = await runtime.vectorIndex.prepare({
    securityDomain: runtime.securityDomain,
    embeddingProfile: runtime.embeddingProfile,
    payloadSchemaVersion: 2,
  });
  const documentIndex = documentIndexFor(runtime, prepared.accessHandle);
  const scopes: PublishedIndexVersion["scopes"] = [
    {
      scopeId: "scope_local",
      scopeVersion: "scpv_aaaa",
      kind: "managed_document",
      documentIndex,
      selector: { kind: "document" },
    },
  ];
  const publication: PublishedIndexVersion = {
    securityDomain: runtime.securityDomain,
    documentIndex,
    scopes,
    manifest: {
      documentIndexId: documentIndex.documentIndexId,
      indexVersion: documentIndex.indexVersion,
      sourceId: documentIndex.sourceId,
      observationId: "obs_local",
      documentId: documentIndex.documentId,
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
      semanticUnitRevisions: { unit_local: "urv_aaaa" },
      chunkRevisions: { chk_aaaa: "crv_aaaa" },
      recordCount: 1,
      recordSetDigest: `sha256:${"a".repeat(64)}`,
      scopeRevisions: [{ scopeId: "scope_local", scopeVersion: "scpv_aaaa" }],
      fallbackCounts: {},
      publishedAt: "2026-08-14T00:00:00.000Z",
    },
  };

  await runtime.publications.commitCurrent(publication);
  return publication;
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
      publicationId: "pub_local",
      observationId: "obs_local",
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
    table: "payments",
    columns: ["failed_reason", "status"],
  };
}

/**
 * A Scope pointing at an index nothing published, so the retriever faults and
 * its item is failed. The unpublished coordinate is the point of the fixture,
 * not an oversight — it is the same one `refuses a retrieval while nothing is
 * published` uses.
 */
function unpublishedDocumentScope(runtime: DaemonRuntime): RetrievalScope {
  return {
    kind: "managed_document",
    reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
    documentIndex: documentIndexFor(runtime, "memory:v1:unprepared"),
    selection: { kind: "document" },
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected the retrieval to fail");
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
    it("binds selection's ports to the adapters this app owns", () => {
      const runtime = buildRuntime();

      expect(runtime.selectionPorts.catalog).toBeInstanceOf(
        RegistryApprovedCardCatalog,
      );
      expect(runtime.selectionPorts.retriever).toBeInstanceOf(
        IngestionManagedDocumentRetriever,
      );
    });

    it("applies the security domain and connector it was configured with", () => {
      const runtime = buildRuntime({
        securityDomain: "x",
        connectorId: "y",
      });

      expect(runtime.securityDomain).toBe("x");
      expect(runtime.connectorId).toBe("y");
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
   * what these assert: the retriever keeps its store in a private field, so a
   * runtime that handed out one instance and wired a second would still satisfy
   * `toBe`. What is asserted instead is that writing into `runtime.publications`
   * changes what the assembled retriever answers.
   */
  describe("shared publication store", () => {
    it("refuses a retrieval while nothing is published", async () => {
      const runtime = buildRuntime();

      const failure = await captureFailure(
        runtime.selectionPorts.retriever.searchChunks(
          queryFor(documentIndexFor(runtime, "memory:v1:unprepared")),
        ),
      );

      expect(failure).toBeInstanceOf(DocumentRetrievalFault);
      expect((failure as DocumentRetrievalFault).code).toBe(
        "index_version_mismatch",
      );
    });

    it("serves that retrieval once the runtime's own store has the publication", async () => {
      const runtime = buildRuntime();
      const publication = await publishWholeDocument(runtime);

      // Empty because no vector records were written, not because anything
      // failed: reaching an empty result means the retriever found the
      // publication, matched the Scope, resolved the connector and the
      // embedding provider, and searched the runtime's vector index.
      await expect(
        runtime.selectionPorts.retriever.searchChunks(
          queryFor(publication.documentIndex),
        ),
      ).resolves.toEqual([]);
    });
  });

  describe("mcp surface", () => {
    it("exposes exactly the two query tools", async () => {
      const runtime = buildRuntime();

      const result = await callMcp(runtime, "tools/list");

      const tools = result["tools"] as readonly { readonly name: string }[];
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_context_cards",
        "resolve_context",
      ]);
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
      expect(policy["payloadSchemaVersion"]).toBe(2);

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
      for (const retired of ["evidence", "contracts", "retrievalFailures"]) {
        expect(Object.hasOwn(payload, retired)).toBe(false);
      }

      // An unconfigured runtime starts on an empty registry database, so an
      // empty candidate list is the correct answer rather than a failure.
      expect(payload["candidates"]).toEqual([]);
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
        "unit_payments_table",
        "cv_sql",
        sqlScope(),
      );
      await approveSingleScopeCard(
        runtime,
        "unit_payment_failures",
        "cv_document",
        unpublishedDocumentScope(runtime),
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
      expect(items.map((item) => item["fulfillment"]).sort()).toEqual([
        "delegated",
        "failed",
      ]);

      for (const item of items) {
        expect(["fulfilled", "delegated", "failed"]).toContain(
          item["fulfillment"],
        );
        const guide = item["guide"] as Readonly<Record<string, unknown>>;
        expect(typeof guide["kind"]).toBe("string");
      }

      // Why it failed, not merely that it did. `runScopeSearch` catches
      // everything and folds an undeclared throw into `retriever_error`, so a
      // fixture that broke for some unrelated reason — a mis-shaped access
      // handle, an adapter that never reached the store — would still land on
      // `failed` and satisfy the state assertion above. Only the code says the
      // item failed for the reason `unpublishedDocumentScope` was written to
      // provoke: the coordinate names an index version nothing published.
      // `retriever_error` would be the fixture rotting, not a passing case.
      const failed = items.find((item) => item["fulfillment"] === "failed");
      expect(failed).toBeDefined();
      expect(failed?.["cardId"]).toBe("unit_payment_failures");
      expect(failed?.["code"]).toBe("index_version_mismatch");

      expect(payload["candidates"]).toHaveLength(2);
    });
  });
});

describe("readDaemonRuntimeOptions", () => {
  it("returns no keys at all for an empty environment", () => {
    // Keys, not equality: `exactOptionalPropertyTypes` makes an absent key
    // different from an explicit `undefined`, and only an absent key selects
    // the default.
    expect(Object.keys(readDaemonRuntimeOptions({}))).toEqual([]);
  });

  it("reads the database location, security domain and connector", () => {
    expect(
      readDaemonRuntimeOptions({
        CONTEXTCTL_REGISTRY_DATABASE: "/tmp/cards.sqlite",
        CONTEXTCTL_SECURITY_DOMAIN: "payments",
        CONTEXTCTL_CONNECTOR_ID: "vector.remote",
      }),
    ).toEqual({
      registryDatabaseLocation: "/tmp/cards.sqlite",
      securityDomain: "payments",
      connectorId: "vector.remote",
    });
  });

  it("treats an empty value as a value rather than as an absent setting", () => {
    const options = readDaemonRuntimeOptions({
      CONTEXTCTL_SECURITY_DOMAIN: "",
    });

    expect(Object.keys(options)).toEqual(["securityDomain"]);
    expect(options.securityDomain).toBe("");
  });

  it("ignores every other variable in the environment", () => {
    expect(
      Object.keys(
        readDaemonRuntimeOptions({ PATH: "/usr/bin", HOME: "/root" }),
      ),
    ).toEqual([]);
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
