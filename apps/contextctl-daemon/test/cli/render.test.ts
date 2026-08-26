import type { CardVersion, ContextCard } from "@contextctl/registry-lifecycle";
import type {
  ContextResolution,
  ContextResolutionItem,
  ManagedDocumentGuide,
  RetrievedDocumentChunk,
  RetrievedDocumentContext,
  SqlRetrievalGuide,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import {
  renderCardListings,
  renderResolution,
  renderSourceListing,
} from "../../src/cli/render.js";

/**
 * Fixtures are hand-built rather than produced by running a resolution.
 *
 * The renderer's contract is over the payload's declared shape, not over
 * whatever the current pipeline happens to emit: a real run cannot produce a
 * `failed` item and a `truncated` context on demand, and driving one would make
 * these assertions depend on selection thresholds that have nothing to do with
 * formatting. The types are the coupling that matters, and they are enforced.
 */

function managedGuide(scopeId: string): ManagedDocumentGuide {
  return {
    kind: "managed_document",
    scopeRef: { scopeId, scopeVersion: "v1" },
    documentIndexId: "index-1",
    sourceId: "source-1",
    documentId: "doc-1",
    indexVersion: "iv-1",
    selector: { kind: "document" },
    limit: 5,
  };
}

function sqlGuide(scopeId: string): SqlRetrievalGuide {
  return {
    kind: "sql",
    scopeRef: { scopeId, scopeVersion: "v2" },
    connector: "postgres.main",
    schema: "public",
    table: "payments",
    columns: ["id", "status"],
    allowedOperations: ["select"],
  };
}

function chunk(
  contextRank: number,
  text: string,
): RetrievedDocumentChunk {
  return {
    contextRank,
    chunkId: `chunk-${String(contextRank)}`,
    chunkRevisionId: `rev-${String(contextRank)}`,
    semanticUnitId: `unit-${String(contextRank)}`,
    documentId: "doc-1",
    text,
    contentDigest: `digest-${String(contextRank)}`,
  };
}

function fulfilledContext(
  chunks: readonly RetrievedDocumentChunk[],
  overrides: Partial<RetrievedDocumentContext> = {},
): RetrievedDocumentContext {
  return {
    contentTrust: "untrusted",
    chunks,
    omitted: [],
    truncated: false,
    ...overrides,
  };
}

function resolution(
  overrides: {
    readonly mode?: ContextResolution["selection"]["mode"];
    readonly scoring?: ContextResolution["policy"]["scoring"];
    readonly selected?: ContextResolution["selection"]["selected"];
    readonly counts?: ContextResolution["selection"]["counts"];
    readonly items?: readonly ContextResolutionItem[];
  } = {},
): ContextResolution {
  return {
    query: "결제 실패 재시도 정책",
    policy: {
      payloadSchemaVersion: 3,
      scoring: overrides.scoring ?? "selection-lexical-v4",
      ranking: "selection-ranking-v2",
      planning: "selection-planning-v1",
      fusion: "rrf-v1",
      assembly: "context-assembly-v2",
      budget: { maxTotalCharacters: 8000, maxChunks: 12 },
    },
    selection: {
      mode: overrides.mode ?? "lexical_degraded",
      selected: overrides.selected ?? [],
      counts: overrides.counts ?? { admitted: 0, deferred: 0, rejected: 0 },
    },
    items: overrides.items ?? [],
  };
}

function fulfilledItem(
  context: RetrievedDocumentContext,
  scopeId = "scope-1",
): ContextResolutionItem {
  return {
    selectedBy: [{ cardId: "card-billing", versionId: "cv-1" }],
    guide: managedGuide(scopeId),
    fulfillment: { status: "fulfilled", executor: "contextctl", context },
  };
}

function failedItem(): ContextResolutionItem {
  return {
    selectedBy: [{ cardId: "card-billing", versionId: "cv-1" }],
    guide: managedGuide("scope-2"),
    fulfillment: {
      status: "failed",
      executor: "contextctl",
      failure: {
        stage: "managed_search",
        code: "index_unavailable",
        retriable: true,
      },
    },
  };
}

function delegatedItem(): ContextResolutionItem {
  return {
    selectedBy: [{ cardId: "card-payments", versionId: "cv-9" }],
    guide: sqlGuide("scope-3"),
    fulfillment: { status: "delegated", executor: "consumer" },
  };
}

function cardVersion(
  id: string,
  validationState: CardVersion["validationState"],
): CardVersion {
  return {
    id,
    cardId: "card-billing",
    lineage: {
      publicationId: "pub-1",
      observationId: "obs-1",
      knowledgeUnitId: "ku-1",
    },
    scopes: [],
    validationState,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

function card(overrides: {
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly versions?: readonly CardVersion[];
  readonly currentVersionId?: string | undefined;
}): ContextCard {
  return {
    id: "card-billing",
    meaning: {
      description: overrides.description ?? "결제 실패 재시도 정책 카드",
      representativeQuestions: ["결제가 실패하면 어떻게 되나요?"],
      aliases: ["빌링"],
      keywords: overrides.keywords ?? ["결제", "재시도"],
    },
    policy: { sensitive: false, allowedUsage: ["answer"] },
    versions: {
      cardId: "card-billing",
      versions: overrides.versions ?? [],
      currentVersionId: overrides.currentVersionId,
    },
  };
}

describe("renderResolution", () => {
  it("says a Scope was not selected instead of printing nothing", () => {
    const rendered = renderResolution(resolution());

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("선택된 Scope가 없습니다");
  });

  it("prints hybrid mode and its scoring policy verbatim", () => {
    const rendered = renderResolution(
      resolution({ mode: "hybrid", scoring: "selection-hybrid-v4" }),
    );

    expect(rendered).toContain("hybrid");
    expect(rendered).toContain("selection-hybrid-v4");
  });

  it("prints degraded mode and its scoring policy verbatim", () => {
    const rendered = renderResolution(
      resolution({
        mode: "lexical_degraded",
        scoring: "selection-lexical-v4",
      }),
    );

    expect(rendered).toContain("lexical_degraded");
    expect(rendered).toContain("selection-lexical-v4");
  });

  it("prints the payload schema version", () => {
    expect(renderResolution(resolution())).toContain("3");
    expect(renderResolution(resolution())).toContain(
      "페이로드 스키마 버전: 3",
    );
  });

  it("prints all three verdict counts", () => {
    const rendered = renderResolution(
      resolution({ counts: { admitted: 2, deferred: 1, rejected: 5 } }),
    );

    expect(rendered).toContain("2");
    expect(rendered).toContain("1");
    expect(rendered).toContain("5");
    expect(rendered).toMatch(/승인 2/u);
    expect(rendered).toMatch(/보류 1/u);
    expect(rendered).toMatch(/기각 5/u);
  });

  it("prints every chunk's contextRank and its whole body", () => {
    const rendered = renderResolution(
      resolution({
        items: [
          fulfilledItem(
            fulfilledContext([
              chunk(1, "첫 번째 청크 본문"),
              chunk(2, "두 번째 청크 본문"),
            ]),
          ),
        ],
      }),
    );

    expect(rendered).toContain("#1");
    expect(rendered).toContain("#2");
    expect(rendered).toContain("첫 번째 청크 본문");
    expect(rendered).toContain("두 번째 청크 본문");
  });

  it("indents every line of a multi-line chunk body", () => {
    const rendered = renderResolution(
      resolution({ items: [fulfilledItem(fulfilledContext([chunk(1, "가\n나")]))] }),
    );

    const lines = rendered.split("\n");
    const first = lines.find((candidate) => candidate.trimEnd().endsWith("가"));
    const second = lines.find((candidate) => candidate.trimEnd().endsWith("나"));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).toMatch(/^ {2,}가$/u);
    expect(second).toMatch(/^ {2,}나$/u);
    // Both lines of one body sit at the same column, or the second reads as a
    // separate report line rather than as a continuation of the document.
    expect(second?.indexOf("나")).toBe(first?.indexOf("가"));
  });

  it("never clips a Korean sentence out of a chunk body", () => {
    const body = "결제 실패는 최대 세 번까지 재시도합니다.";
    const rendered = renderResolution(
      resolution({ items: [fulfilledItem(fulfilledContext([chunk(1, body)]))] }),
    );

    expect(rendered).toContain(body);
  });

  it("reports that a context was truncated", () => {
    const rendered = renderResolution(
      resolution({
        items: [
          fulfilledItem(
            fulfilledContext([chunk(1, "본문")], { truncated: true }),
          ),
        ],
      }),
    );

    expect(rendered).toContain("truncated=true");
  });

  it("reports omitted chunks", () => {
    const rendered = renderResolution(
      resolution({
        items: [
          fulfilledItem(
            fulfilledContext([chunk(1, "본문")], {
              omitted: [
                {
                  chunkId: "chunk-9",
                  chunkRevisionId: "rev-9",
                  reason: "duplicate_content",
                },
              ],
            }),
          ),
        ],
      }),
    );

    expect(rendered).toContain("제외된 청크");
    expect(rendered).toContain("chunk-9");
    expect(rendered).toContain("duplicate_content");
  });

  it("prints a failed item's opaque code and its retriable flag", () => {
    const rendered = renderResolution(resolution({ items: [failedItem()] }));

    expect(rendered).toContain("failed");
    expect(rendered).toContain("index_unavailable");
    expect(rendered).toContain("retriable");
    expect(rendered).toContain("true");
  });

  it("marks a delegated item as the consumer's own work", () => {
    const rendered = renderResolution(resolution({ items: [delegatedItem()] }));

    expect(rendered).toContain("delegated");
    expect(rendered).toContain("consumer");
    expect(rendered).toContain("직접 조회");
    expect(rendered).toContain("scope-3@v2");
  });

  it("states the untrusted content contract when a body is present", () => {
    const rendered = renderResolution(
      resolution({ items: [fulfilledItem(fulfilledContext([chunk(1, "본문")]))] }),
    );

    expect(rendered).toContain("contentTrust=untrusted");
  });

  it("lists selected Cards in rank order", () => {
    const rendered = renderResolution(
      resolution({
        selected: [
          { cardId: "card-first", versionId: "cv-1" },
          { cardId: "card-second", versionId: "cv-2" },
        ],
      }),
    );

    expect(rendered).toContain("card-first");
    expect(rendered).toContain("card-second");
    expect(rendered.indexOf("card-first")).toBeLessThan(
      rendered.indexOf("card-second"),
    );
  });

  it("says no Card answered when the selection is empty", () => {
    expect(renderResolution(resolution())).toContain("선택된 Card: 없음");
  });
});

describe("renderCardListings", () => {
  it("points an operator at ingest when nothing is registered", () => {
    const rendered = renderCardListings([]);

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("contextctl ingest");
  });

  it("shows the current version of an approved Card", () => {
    const rendered = renderCardListings([
      {
        card: card({
          versions: [cardVersion("cv-1", "validated")],
          currentVersionId: "cv-1",
        }),
        pendingVersionIds: [],
      },
    ]);

    expect(rendered).toContain("승인");
    expect(rendered).toContain("cv-1");
  });

  it("lists every pending version of an unapproved Card", () => {
    const rendered = renderCardListings([
      {
        card: card({
          versions: [cardVersion("cv-2", "draft"), cardVersion("cv-3", "draft")],
          currentVersionId: undefined,
        }),
        pendingVersionIds: ["cv-2", "cv-3"],
      },
    ]);

    expect(rendered).toContain("cv-2");
    expect(rendered).toContain("cv-3");
    expect(rendered).toContain("승인 대기");
  });

  it("prints a long description and every keyword in full", () => {
    const description =
      "이 Card는 결제 실패 시의 재시도 정책, 재시도 간격, 최대 재시도 횟수, " +
      "그리고 최종 실패 후 환불 처리까지의 전 과정을 설명한다. 승인자는 이 " +
      "설명이 실제 문서 내용과 일치하는지 확인한 뒤 승인 여부를 결정한다.";
    const keywords = ["결제", "재시도", "환불", "실패", "정책"];
    const rendered = renderCardListings([
      { card: card({ description, keywords }), pendingVersionIds: [] },
    ]);

    expect(rendered).toContain(description);
    for (const keyword of keywords) {
      expect(rendered).toContain(keyword);
    }
  });

  it("marks an empty keyword list rather than leaving a blank", () => {
    const rendered = renderCardListings([
      { card: card({ keywords: [] }), pendingVersionIds: [] },
    ]);

    expect(rendered).toContain("키워드: (없음)");
  });
});

describe("grounding evidence on the listing", () => {
  // SEAM-106 §9.1: the verdict, the origin of the words, factCoverage and the
  // change against the previous version are what the operator reads to decide.
  const grounded: CardVersion = {
    ...cardVersion("cv-9", "validated"),
    grounding: {
      verdict: "needs_review",
      findings: [
        {
          rule: "meaning.modelAuthored",
          message: "expression written by model gemma4-12b-qat awaits an operator's semantic review",
          severity: "review",
        },
      ],
      factCoverage: { covered: ["section.label"], uncovered: ["document.title"] },
      origin: { generator: "model", model: "gemma4-12b-qat" },
    },
    changeFromPrevious: {
      previousVersionId: "cv-8",
      changedFields: ["description"],
      coverageLost: ["document.title"],
      coverageGained: [],
    },
  };

  it("shows verdict, origin, coverage and the change against the predecessor", () => {
    const rendered = renderCardListings([
      {
        card: card({ versions: [grounded], currentVersionId: undefined }),
        pendingVersionIds: ["cv-9"],
      },
    ]);

    expect(rendered).toContain("needs_review");
    expect(rendered).toContain("gemma4-12b-qat");
    expect(rendered).toContain("사실 반영 1/2");
    expect(rendered).toContain("미반영 사실: document.title");
    expect(rendered).toContain("이전 버전(cv-8) 대비 변경: description");
    expect(rendered).toContain("반영이 사라진 사실: document.title");
  });

  it("says a model outage shaped the words when the origin degraded", () => {
    const degraded: CardVersion = {
      ...grounded,
      grounding: {
        verdict: "validated",
        findings: [],
        factCoverage: { covered: [], uncovered: [] },
        origin: { generator: "deterministic", fallbackFromModel: "gemma4-12b-qat" },
      },
    };
    const rendered = renderCardListings([
      { card: card({ versions: [degraded] }), pendingVersionIds: [] },
    ]);

    expect(rendered).toContain("모델 gemma4-12b-qat 장애로 대체");
  });

  it("says so when a version predates grounding-v1", () => {
    const rendered = renderCardListings([
      {
        card: card({ versions: [cardVersion("cv-1", "validated")] }),
        pendingVersionIds: [],
      },
    ]);

    expect(rendered).toContain("근거: 기록 없음");
  });
});

describe("renderSourceListing", () => {
  it("guides an operator when no source is registered", () => {
    const rendered = renderSourceListing([]);

    expect(rendered.length).toBeGreaterThan(0);
    // The exact next command, not just "there is nothing here". An empty
    // listing that does not name `source add` leaves the operator with a
    // correct statement and no move.
    expect(rendered).toContain("등록된 Source가 없습니다");
    expect(rendered).toContain("contextctl source add");
  });

  it("prints the reference, path and display name of every source", () => {
    const rendered = renderSourceListing([
      {
        reference: "src-1",
        path: "/tmp/handbook.md",
        displayName: "handbook.md",
      },
      { reference: "src-2", path: "/tmp/policy.md", displayName: "policy.md" },
    ]);

    for (const expected of [
      "src-1",
      "/tmp/handbook.md",
      "handbook.md",
      "src-2",
      "/tmp/policy.md",
      "policy.md",
    ]) {
      expect(rendered).toContain(expected);
    }
  });
});

describe("every renderer", () => {
  it("returns a string the caller terminates itself", () => {
    const rendered = [
      renderResolution(resolution()),
      renderResolution(
        resolution({
          selected: [{ cardId: "card-first", versionId: "cv-1" }],
          items: [
            fulfilledItem(fulfilledContext([chunk(1, "본문")])),
            failedItem(),
            delegatedItem(),
          ],
        }),
      ),
      renderCardListings([]),
      renderCardListings([
        {
          card: card({
            versions: [cardVersion("cv-1", "validated")],
            currentVersionId: "cv-1",
          }),
          pendingVersionIds: ["cv-2"],
        },
      ]),
      renderSourceListing([]),
      renderSourceListing([
        { reference: "src-1", path: "/tmp/a.md", displayName: "a.md" },
      ]),
    ];

    for (const output of rendered) {
      expect(output.endsWith("\n")).toBe(false);
    }
  });
});
