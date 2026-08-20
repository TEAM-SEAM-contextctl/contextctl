import {
  InMemoryVectorIndexAdapter,
  QdrantVectorIndexAdapter,
  type QdrantVectorIndexAdapterOptions,
  type VectorIndexPort,
} from "@contextctl/ingestion-indexing";

import { readNonEmpty } from "./paths.js";

/**
 * Which physical vector index a CLI invocation is talking to.
 *
 * The distinction exists because it changes what an *empty* answer means. A CLI
 * process starts and exits around every command an operator types, so an
 * in-memory index is not a slower store — it is a store the next command cannot
 * read at all. `contextctl ingest` writes it, the process exits, and
 * `contextctl query` opens an empty one and succeeds with no items. Nothing in
 * that sequence fails, which is exactly the problem: the operator sees a working
 * command answering nothing, and has no reason to suspect the store.
 *
 * So the kind is carried out of resolution rather than discarded, and the two
 * diagnosis functions below turn it into something an operator can read.
 */
export type VectorBackendKind = "in_memory" | "qdrant";

export interface VectorBackend {
  readonly kind: VectorBackendKind;
  readonly vectorIndex: VectorIndexPort;
  /**
   * The endpoint, for diagnostics only, and only when one was configured.
   *
   * Stripped of userinfo, query and fragment before it is stored — see
   * `diagnosticEndpoint`. Never carries the API key.
   */
  readonly endpoint?: string;
}

const QDRANT_URL_VARIABLE = "CONTEXTCTL_QDRANT_URL";
const QDRANT_API_KEY_VARIABLE = "CONTEXTCTL_QDRANT_API_KEY";
const QDRANT_TIMEOUT_VARIABLE = "CONTEXTCTL_QDRANT_TIMEOUT_MS";

/**
 * Binds the vector index a CLI invocation will use, environment first.
 *
 * Presence of `CONTEXTCTL_QDRANT_URL` is the whole switch: an operator who
 * names an endpoint wants that endpoint, and there is no second variable
 * selecting a "mode" that could disagree with it. Absent, the in-memory adapter
 * keeps a fresh install runnable with no infrastructure at all — which is worth
 * keeping, but is why `ingestVolatilityWarning` exists.
 *
 * Every malformed value throws rather than degrading. Falling back to the
 * in-memory adapter because a timeout failed to parse would produce the exact
 * silent-empty-result failure this module was written to prevent, and it would
 * do it to an operator who had configured a durable store correctly.
 */
export function resolveVectorBackend(
  environment: Readonly<Partial<Record<string, string>>>,
): VectorBackend {
  const url = readNonEmpty(environment, QDRANT_URL_VARIABLE);
  if (url === undefined) {
    return { kind: "in_memory", vectorIndex: new InMemoryVectorIndexAdapter() };
  }

  const apiKey = readNonEmpty(environment, QDRANT_API_KEY_VARIABLE);
  const timeoutMs = readTimeoutMs(environment);
  // Spread rather than assigned: `exactOptionalPropertyTypes` makes an explicit
  // `undefined` different from an absent key, and the adapter reads the absent
  // key as "no API key" / "default timeout" rather than as a supplied nothing.
  const options: QdrantVectorIndexAdapterOptions = {
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  // Constructed before `diagnosticEndpoint` is trusted for display, because the
  // adapter is the authority on which endpoints are acceptable at all: it
  // refuses plaintext HTTP to anything but loopback, and refuses userinfo
  // outright. Anything it rejects must not reach an operator as a configured
  // endpoint.
  const vectorIndex = new QdrantVectorIndexAdapter(options);
  return { kind: "qdrant", vectorIndex, endpoint: diagnosticEndpoint(url) };
}

/**
 * The endpoint reduced to the parts that are safe to print.
 *
 * Scheme, host and path only. Userinfo is dropped because a URL is the one place
 * a credential can hide inside something an operator thinks of as an address,
 * and query and fragment are dropped for the same reason — a deployment that
 * passes its key as `?api-key=` would otherwise leak it into every warning line.
 * Keeping an allowlist of components rather than deleting known-bad ones means a
 * component nobody thought about cannot leak by default.
 */
function diagnosticEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function readTimeoutMs(
  environment: Readonly<Partial<Record<string, string>>>,
): number | undefined {
  const raw = readNonEmpty(environment, QDRANT_TIMEOUT_VARIABLE);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  // `Number.isSafeInteger` rejects NaN, infinities and fractions in one test;
  // `parseInt` is not used precisely because it would read "1.5" as 1 and "abc5"
  // as NaN-by-prefix, turning a typo into a plausible-looking timeout.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      `${QDRANT_TIMEOUT_VARIABLE} must be a positive integer number of milliseconds`,
    );
  }
  return parsed;
}

/**
 * What to tell an operator after an ingest that wrote to a volatile index.
 *
 * Returned rather than printed: this module resolves configuration and must stay
 * callable from a test or a server without writing to a stream. The caller owns
 * stderr, and owns whether a warning is worth showing at all.
 *
 * The moment matters more than the wording. Said at ingest time it is a warning
 * about a future command; said at query time it would be an explanation of a
 * result the operator has already misread.
 *
 * What it must not say is "set the variable and ingest again". That was the
 * advice here, and it does not work: the second ingest reports `unchanged` and
 * skips chunking, embedding and index publication, because the observation
 * checkpoint tracks the *document* and nothing looks at whether an index exists.
 * Following it leaves an operator with approved Cards and no vectors, which is
 * the exact state this warning exists to prevent.
 */
export function ingestVolatilityWarning(
  backend: VectorBackend,
): string | undefined {
  if (backend.kind !== "in_memory") return undefined;
  return [
    "경고: 방금 만든 색인은 in-memory 라 이 프로세스가 끝나면 함께 사라진다.",
    "다음 `contextctl query` 는 새 프로세스에서 빈 색인을 읽고, 오류 없이 빈 결과로 성공한다.",
    ...indexRecoveryGuidance(),
  ].join("\n");
}

/**
 * How to get a durable index, and how to rebuild one that is already gone.
 *
 * Shared by the two places that used to give the same wrong instruction. The
 * order is deliberate: configuring the backend before the first ingest is the
 * only path that costs nothing, and it is what an operator reading this at ingest
 * time can still do.
 *
 * The rebuild names the Ingestion store because deleting it is the only recovery
 * the CLI currently offers, and it is safe in a way that is not obvious — a
 * Publication id is derived from the document's content, so re-publishing the
 * same document produces the same id and Registry answers `already_claimed`.
 * Cards, approvals and the audit trail live in the Registry store and are never
 * touched. Saying so is the point: an operator who thinks they are about to lose
 * their approvals will not run it.
 *
 * `contextctl paths` rather than a literal filename, because
 * `CONTEXTCTL_INGESTION_DATABASE` can move it and a hard-coded path would be
 * wrong for exactly the operator who configured one.
 */
function indexRecoveryGuidance(): readonly string[] {
  return [
    `가장 간단한 방법은 처음부터 \`${QDRANT_URL_VARIABLE}\` 을 설정한 뒤 ingest 하는 것이다.`,
    "이미 수집한 문서는 `ingest` 를 다시 해도 `unchanged` 로 건너뛴다 — 문서가 바뀌지 않았기 때문이다.",
    "색인만 다시 만들려면 `contextctl paths` 가 알려주는 Ingestion 저장소 파일을 지우고 ingest 하라. 승인한 Card 는 Registry 저장소에 있으므로 유지된다.",
    "또는 `contextctl serve` 로 ingest 와 query 를 한 프로세스에서 실행하라.",
  ];
}

/**
 * Why a query came back with nothing, when that can be said without guessing.
 *
 * Only two causes are diagnosable from what a single process can see: nothing
 * was ever approved, or the index this process opened is one that cannot contain
 * what an earlier process wrote. Both are configuration or sequencing mistakes
 * with a concrete next step.
 *
 * A durable backend returning nothing is deliberately left undiagnosed. From
 * here it is indistinguishable from a query that legitimately matched nothing,
 * and inventing a cause for a correct answer teaches an operator to ignore the
 * line that matters.
 */
export function emptyResultDiagnosis(input: {
  readonly backend: VectorBackend;
  readonly approvedCardCount: number;
  readonly itemCount: number;
}): string | undefined {
  if (input.itemCount > 0) return undefined;

  // Checked before the index, because an unapproved catalog makes every backend
  // answer nothing: pointing at the store first would send an operator to
  // configure Qdrant for a problem Qdrant cannot fix.
  if (input.approvedCardCount === 0) {
    return [
      "승인된 Card 가 하나도 없다 — 선택할 후보가 없으므로 질의는 언제나 빈 결과다.",
      "`contextctl cards approve` 로 Card 를 먼저 승인하라.",
    ].join("\n");
  }

  if (input.backend.kind === "in_memory") {
    return [
      `승인된 Card 는 ${String(input.approvedCardCount)}개 있는데 읽을 색인이 없다 — 이 프로세스는 방금 시작했고 in-memory 색인은 비어 있다.`,
      "앞서 `contextctl ingest` 가 쓴 색인은 그 프로세스와 함께 사라졌다.",
      ...indexRecoveryGuidance(),
    ].join("\n");
  }

  return undefined;
}
