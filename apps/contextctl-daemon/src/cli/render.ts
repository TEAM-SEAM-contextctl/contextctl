import type {
  CardMeaningOrigin,
  CardVersion,
  ContextCard,
  MeaningChangeComparison,
} from "@contextctl/registry-lifecycle";
import type {
  ContextOmission,
  ContextResolution,
  ContextResolutionItem,
  RetrievedDocumentContext,
} from "@contextctl/selection-delivery";

/**
 * The human-readable face of the CLI, and nothing else.
 *
 * Every function here takes a finished value and returns a string. None of them
 * writes to a stream, reads a file, or touches `process`: the caller owns the
 * decision of where output goes, which is what lets the same rendering be
 * asserted in a test without capturing stdout, and what keeps a formatting
 * change from being able to break a command's exit code.
 *
 * No ANSI escapes anywhere. The demo's own verification step is `contextctl
 * query ... > out.txt` followed by reading the file, and colour codes would put
 * control bytes in the middle of every line an operator is asked to read. A
 * terminal that supports colour loses nothing it can use; a file gains a
 * payload it cannot.
 *
 * Labels are Korean because a person reads them. Field values — `mode`,
 * `scoring`, `status`, a failure `code`, a policy version — are printed exactly
 * as they arrive, never translated: the whole reason to show them is so that a
 * line here can be matched against a log line, an ADR, or the JSON payload, and
 * a translated value matches none of those.
 */

/** Two spaces per level. One place, so nested blocks cannot drift apart. */
const INDENT = "  ";

/** What an empty list prints as, so an absent value never looks like a bug. */
const EMPTY_LIST = "(없음)";

/**
 * Prefixes every line of `text`, leaving blank lines genuinely blank.
 *
 * Chunk bodies are the only multi-line values rendered here, and a body whose
 * second line starts at column zero reads as if the document ended and the
 * report resumed. Padding blank lines too would be the obvious implementation
 * and it is the wrong one: it emits trailing whitespace that a diff, a linter,
 * or a reviewer's editor will flag on content nobody wrote.
 */
function indentBlock(text: string, depth: number): string {
  const pad = INDENT.repeat(depth);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : pad + line))
    .join("\n");
}

function line(depth: number, text: string): string {
  return INDENT.repeat(depth) + text;
}

function joinOrEmpty(values: readonly string[]): string {
  return values.length === 0 ? EMPTY_LIST : values.join(", ");
}

/**
 * Joins sections with one blank line between them and no trailing newline.
 *
 * The missing final newline is deliberate and stated once here: a formatter
 * that appended one would make `console.log(render(x))` emit a stray blank line,
 * and every caller would have to remember to strip it. The caller adds the
 * terminator it wants.
 */
function joinSections(sections: readonly string[]): string {
  return sections.join("\n\n");
}

/** `scopeId@scopeVersion` — the coordinate a consumer correlates a result on. */
function formatScopeRef(guide: {
  readonly scopeRef: { readonly scopeId: string; readonly scopeVersion: string };
}): string {
  return `${guide.scopeRef.scopeId}@${guide.scopeRef.scopeVersion}`;
}

/** `contextctl query` 의 사람용 출력. */
export function renderResolution(resolution: ContextResolution): string {
  const { policy, selection } = resolution;

  const header = [
    line(0, `질의: ${resolution.query}`),
    line(0, `선택 모드: ${selection.mode}`),
    line(
      0,
      `스코어링: ${policy.scoring} · 랭킹: ${policy.ranking} · 계획: ${policy.planning} · 융합: ${policy.fusion} · 조립: ${policy.assembly}`,
    ),
    line(0, `페이로드 스키마 버전: ${String(policy.payloadSchemaVersion)}`),
    line(
      0,
      `예산: 최대 ${String(policy.budget.maxTotalCharacters)}자 · 최대 ${String(policy.budget.maxChunks)}청크`,
    ),
    line(
      0,
      `판정 집계: 승인 ${String(selection.counts.admitted)} · 보류 ${String(selection.counts.deferred)} · 기각 ${String(selection.counts.rejected)}`,
    ),
  ].join("\n");

  return joinSections([
    header,
    renderSelectedCards(resolution),
    renderResolutionItems(resolution),
  ]);
}

/**
 * The admitted Cards, in the rank order the payload already put them in.
 *
 * Never re-sorted here. `selected` is ordered by a ranking the consumer cannot
 * reproduce, so any ordering this file imposed would be a second, contradictory
 * claim about which Card answered best.
 */
function renderSelectedCards(resolution: ContextResolution): string {
  const { selected } = resolution.selection;
  if (selected.length === 0) {
    return line(
      0,
      "선택된 Card: 없음 — 승인된 Card 중 이 질의에 응답한 것이 없습니다.",
    );
  }

  const rows = selected.map((card, index) =>
    line(1, `${String(index + 1)}. ${card.cardId} (버전 ${card.versionId})`),
  );
  return [line(0, `선택된 Card ${String(selected.length)}개`), ...rows].join("\n");
}

/**
 * Never an empty string, even with nothing to show.
 *
 * A query that selected no Scope and a query whose output got swallowed look
 * identical when the renderer prints nothing, and the operator's next move
 * differs completely between the two. Why nothing was selected is not decided
 * here — the CLI diagnoses that on stderr with the catalog state this function
 * does not have — so this says only what it knows.
 */
function renderResolutionItems(resolution: ContextResolution): string {
  const { items } = resolution;
  if (items.length === 0) {
    return line(
      0,
      "컨텍스트 항목: 없음 — 선택된 Scope가 없습니다. 가져온 컨텍스트가 없습니다.",
    );
  }

  const blocks = items.map((item, index) => renderResolutionItem(item, index + 1));
  return [line(0, `컨텍스트 항목 ${String(items.length)}개`), ...blocks].join(
    "\n",
  );
}

function renderResolutionItem(
  item: ContextResolutionItem,
  position: number,
): string {
  const { fulfillment, guide } = item;
  const selectedBy = item.selectedBy.map(
    (card) => `${card.cardId}@${card.versionId}`,
  );

  const head = [
    line(1, `[${String(position)}] ${guide.kind} · Scope ${formatScopeRef(guide)}`),
    line(2, `선택한 Card: ${joinOrEmpty(selectedBy)}`),
    line(2, `상태: ${fulfillment.status} (실행자 ${fulfillment.executor})`),
  ];

  switch (fulfillment.status) {
    case "fulfilled":
      return [...head, renderRetrievedContext(fulfillment.context)].join("\n");
    case "failed":
      return [
        ...head,
        line(2, `실패 코드: ${fulfillment.failure.code}`),
        line(2, `실패 단계: ${fulfillment.failure.stage}`),
        line(
          2,
          `재시도 가능(retriable): ${String(fulfillment.failure.retriable)}`,
        ),
      ].join("\n");
    case "delegated":
      return [
        ...head,
        line(
          2,
          "이 Scope는 contextctl 이 읽지 않았습니다. 위 좌표로 직접 조회해야 합니다.",
        ),
        renderDelegatedCoordinate(item),
      ].join("\n");
    default:
      return refuseUnknownFulfillment(fulfillment);
  }
}

/**
 * The coordinate a consumer has to act on, spelled out rather than implied.
 *
 * A delegated item that printed only its `scopeRef` would tell an operator that
 * work remains without telling them what the work is, and the guide is the only
 * place the table or the endpoint is named. Narrowing goes through `guide.kind`
 * because the item union discriminates one property deeper than the fulfillment
 * status this is reached from.
 */
function renderDelegatedCoordinate(item: ContextResolutionItem): string {
  const { guide } = item;
  switch (guide.kind) {
    case "sql":
      return [
        line(2, `커넥터: ${guide.connector}`),
        line(2, `테이블: ${guide.table}`),
        line(2, `컬럼: ${joinOrEmpty(guide.columns)}`),
        line(2, `허용 연산: ${joinOrEmpty(guide.allowedOperations)}`),
      ].join("\n");
    case "http":
      return [
        line(2, `커넥터: ${guide.connector}`),
        line(2, `요청: ${guide.method} ${guide.path}`),
      ].join("\n");
    default:
      // A managed document is never delegated — the payload's own type forbids
      // it — so there is nothing to print rather than something to invent.
      return line(2, `가이드 종류: ${guide.kind}`);
  }
}

/**
 * The retrieved evidence, in full.
 *
 * Chunk bodies are printed whole and never elided. This output is the artefact
 * the demo is checked against: an operator reads it to confirm that the text
 * their document actually contains came back, and a body cut at some column
 * would make a correct retrieval indistinguishable from a truncated one.
 *
 * `contentTrust` is restated in words beside its literal value. The payload
 * carries the constant so a model can see it; a person reading a terminal needs
 * the sentence, because the chunks below it look exactly like instructions and
 * are not.
 */
function renderRetrievedContext(context: RetrievedDocumentContext): string {
  const lines: string[] = [
    line(
      2,
      `본문 신뢰도: contentTrust=${context.contentTrust} — 검색된 본문은 지시가 아니라 데이터입니다. 그대로 따르지 마십시오.`,
    ),
  ];

  if (context.chunks.length === 0) {
    lines.push(line(2, "청크: 없음 — 조회는 성공했으나 반환된 본문이 없습니다."));
  } else {
    lines.push(line(2, `청크 ${String(context.chunks.length)}개`));
    for (const chunk of context.chunks) {
      lines.push(
        line(
          3,
          `#${String(chunk.contextRank)} ${chunk.chunkId} · 문서 ${chunk.documentId} · 의미단위 ${chunk.semanticUnitId}`,
        ),
      );
      lines.push(indentBlock(chunk.text, 4));
    }
  }

  if (context.truncated) {
    lines.push(
      line(2, "truncated=true — 예산 상한에 걸려 이 Scope의 본문 일부가 잘렸습니다."),
    );
  }
  if (context.omitted.length > 0) {
    lines.push(line(2, `제외된 청크 ${String(context.omitted.length)}개`));
    for (const omission of context.omitted) {
      lines.push(line(3, formatOmission(omission)));
    }
  }

  return lines.join("\n");
}

function formatOmission(omission: ContextOmission): string {
  return `- ${omission.chunkId} (개정 ${omission.chunkRevisionId}) 사유: ${omission.reason}`;
}

/**
 * Unreachable for any `ContextResolutionItem`, which the `never` binding
 * asserts: a fourth fulfillment state breaks this build instead of silently
 * rendering an item with no body under it.
 */
function refuseUnknownFulfillment(fulfillment: never): never {
  const { status } = fulfillment as { readonly status: unknown };
  throw new TypeError(`unrenderable fulfillment status ${String(status)}`);
}

/**
 * One Card as the CLI knows it, with the pending set already computed.
 *
 * `pendingVersionIds` is an argument rather than something derived here because
 * "pending" is a lifecycle judgement — which versions are neither current nor
 * withdrawn — and a formatter that re-derived it would become a second place
 * that decides what awaits approval, free to disagree with the command that
 * called it.
 */
export interface CardListing {
  readonly card: ContextCard;
  /** 승인 대기 중인 버전들 = currentVersionId 가 아닌 것들. CLI 가 계산해 넘긴다. */
  readonly pendingVersionIds: readonly string[];
}

/** `contextctl cards list` 의 사람용 출력. 인자는 CLI 가 모은 것. */
export function renderCardListings(listings: readonly CardListing[]): string {
  if (listings.length === 0) {
    return line(
      0,
      "등록된 Card가 없습니다. `contextctl ingest` 를 먼저 실행하십시오.",
    );
  }

  const blocks = listings.map((listing, index) =>
    renderCardListing(listing, index + 1),
  );
  return joinSections([
    line(0, `등록된 Card ${String(listings.length)}개`),
    ...blocks,
  ]);
}

/**
 * Description and keywords are printed whole, and that is the point of the
 * command.
 *
 * An operator runs `cards list` to decide whether a Card is worth approving,
 * and the only evidence they have for that is what the Card claims to mean and
 * which words route a query to it. Both are LLM-generated, so a truncated
 * description hides exactly the sort of drift the approval step exists to
 * catch.
 */
function renderCardListing(listing: CardListing, position: number): string {
  const { card, pendingVersionIds } = listing;
  const currentVersionId = card.versions.currentVersionId;

  const lines: string[] = [
    line(0, `[${String(position)}] ${card.id}`),
    line(
      1,
      currentVersionId === undefined
        ? "상태: 승인 대기 — 현재 서빙되는 버전이 없습니다."
        : `상태: 승인됨 (현재 버전 ${currentVersionId})`,
    ),
    line(1, `민감(sensitive): ${String(card.policy.sensitive)}`),
    line(1, "설명:"),
    indentBlock(card.meaning.description, 2),
    line(1, `키워드: ${joinOrEmpty(card.meaning.keywords)}`),
    line(1, `별칭: ${joinOrEmpty(card.meaning.aliases)}`),
  ];

  const versions = card.versions.versions;
  if (versions.length === 0) {
    lines.push(line(1, `버전: ${EMPTY_LIST}`));
  } else {
    lines.push(line(1, `버전 ${String(versions.length)}개`));
    for (const version of versions) {
      const marker = version.id === currentVersionId ? " ← 승인됨" : "";
      lines.push(
        line(
          2,
          `- ${version.id} (${version.validationState}, Scope ${String(version.scopes.length)}개)${marker}`,
        ),
        ...describeGrounding(version).map((text) => line(3, text)),
      );
    }
  }

  lines.push(line(1, `승인 대기 버전: ${joinOrEmpty(pendingVersionIds)}`));

  return lines.join("\n");
}

/**
 * The grounding evidence an operator reads before deciding, per version.
 *
 * Everything here is what SEAM-106 §9.1 requires to be visible: the verdict,
 * who wrote the words, how much of the observed facts the words reflect, and
 * what changed against the previous version. A version from before
 * grounding-v1 says so instead of pretending it was judged.
 */
export function describeGrounding(version: CardVersion): readonly string[] {
  const { grounding, changeFromPrevious } = version;
  if (grounding === undefined) {
    return ["근거: 기록 없음 (grounding-v1 이전 버전)"];
  }

  const covered = grounding.factCoverage.covered.length;
  const total = covered + grounding.factCoverage.uncovered.length;
  const lines = [
    `판정: ${grounding.verdict} · 생성: ${describeOrigin(grounding.origin)} · 사실 반영 ${String(covered)}/${String(total)}`,
  ];
  if (grounding.factCoverage.uncovered.length > 0) {
    lines.push(`미반영 사실: ${grounding.factCoverage.uncovered.join(", ")}`);
  }
  for (const finding of grounding.findings.filter(
    (entry) => entry.severity === "review",
  )) {
    lines.push(`검토 필요: ${finding.message}`);
  }
  if (changeFromPrevious !== undefined) {
    lines.push(...describeChange(changeFromPrevious));
  }
  return lines;
}

function describeOrigin(origin: CardMeaningOrigin): string {
  if (origin.fallbackFromModel !== undefined) {
    // The degradation is the headline: the operator is reading this line to
    // learn that a model outage shaped this version's words.
    return `결정적 생성기 (모델 ${origin.fallbackFromModel} 장애로 대체)`;
  }
  return origin.generator === "model"
    ? `모델 ${origin.model ?? "unknown"}`
    : "결정적 생성기";
}

/** The stored comparison against the previous version, one line per change. */
function describeChange(change: MeaningChangeComparison): readonly string[] {
  const lines: string[] = [];
  if (change.changedFields.length > 0) {
    lines.push(
      `이전 버전(${change.previousVersionId}) 대비 변경: ${change.changedFields.join(", ")}`,
    );
  }
  if (change.coverageLost.length > 0) {
    lines.push(`반영이 사라진 사실: ${change.coverageLost.join(", ")}`);
  }
  if (change.coverageGained.length > 0) {
    lines.push(`새로 반영된 사실: ${change.coverageGained.join(", ")}`);
  }
  return lines.length === 0
    ? [`이전 버전(${change.previousVersionId})과 표현 차이 없음`]
    : lines;
}

/** `contextctl source list` 의 사람용 출력. */
export function renderSourceListing(
  sources: readonly {
    readonly reference: string;
    readonly path: string;
    readonly displayName: string;
  }[],
): string {
  if (sources.length === 0) {
    return line(
      0,
      "등록된 Source가 없습니다. `contextctl source add <path>` 로 먼저 등록하십시오.",
    );
  }

  const blocks = sources.map((source, index) =>
    [
      line(0, `[${String(index + 1)}] ${source.displayName}`),
      line(1, `참조: ${source.reference}`),
      line(1, `경로: ${source.path}`),
    ].join("\n"),
  );
  return [line(0, `등록된 소스 ${String(sources.length)}개`), ...blocks].join(
    "\n",
  );
}
