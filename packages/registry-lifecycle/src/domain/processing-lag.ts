import type { PublicationId, SourceId } from "@contextctl/contracts";

import type { ReachabilityReport, ScopeReachability } from "./scope-reachability.js";

/**
 * How far behind one Source's consumption is, and by how long.
 *
 * Separate from failure on purpose. A Source that is two Publications behind is
 * *late*, and the Cards it already produced keep serving correctly — they are
 * older than the source, not wrong about it. A Source whose LLM is unreachable
 * is *broken*. Reporting both through one field would leave an operator unable
 * to tell "wait" from "fix", which the design calls out as a requirement of its
 * own: 처리 지연과 장애를 구분해서 노출한다.
 */
export interface SourceProcessingLag {
  readonly sourceId: SourceId;
  /** Where consumption stopped. Absent when nothing has been consumed yet. */
  readonly processedPublicationId?: PublicationId | undefined;
  /** The newest Publication Ingestion has made ready for this Source. */
  readonly latestReadyPublicationId?: PublicationId | undefined;
  /**
   * Whether the newest ready Publication is still unconsumed.
   *
   * A boolean rather than a count. Counting would mean walking the chain
   * backwards one `previousPublicationId` at a time — a query per Publication —
   * and the number answers a question an operator rarely asks: what they act on
   * is how stale the Cards are, which `freshnessLagMs` says directly. If a count
   * turns out to be needed, it belongs behind a listing capability rather than a
   * per-Publication walk.
   */
  readonly behind: boolean;
  /**
   * Milliseconds between the newest ready Publication and the consumed one.
   *
   * Absent when either side has no timestamp to compare — nothing consumed yet,
   * or nothing published yet. Absent is not zero: zero means caught up, and
   * reporting zero for "cannot tell" would hide a Source that has never been
   * consumed at all.
   */
  readonly freshnessLagMs?: number | undefined;
}

/** The two ends of one Source's consumption, as timestamps and ids. */
export interface SourceConsumptionSighting {
  readonly sourceId: SourceId;
  /**
   * What the cursor points at, and when that Publication was produced.
   *
   * `producedAt` is optional because the two facts come from different reads. The
   * cursor is Registry's own state and is always known; the timestamp requires
   * fetching the Publication, which a composition may not be able to do. Losing
   * the id along with the timestamp would drop the watermark — the one value the
   * division of responsibilities names as ours — over a missing second read.
   */
  readonly processed?:
    | { readonly publicationId: PublicationId; readonly producedAt?: string | undefined }
    | undefined;
  readonly latestReady?:
    | { readonly publicationId: PublicationId; readonly producedAt: string }
    | undefined;
}

/**
 * Judges one Source's processing delay from the two ends of its chain.
 *
 * Pure and total: every combination of present and absent ends produces an
 * answer, because "nothing published yet" and "nothing consumed yet" are both
 * normal states of a Source that was just registered, and a function that threw
 * on them would make a first run look like a fault.
 */
export function judgeSourceProcessingLag(
  sighting: SourceConsumptionSighting,
): SourceProcessingLag {
  const { sourceId, processed, latestReady } = sighting;

  // Nothing ready means nothing to be behind, whatever the cursor says. A Source
  // whose documents were all removed reaches this state legitimately.
  if (latestReady === undefined) {
    return {
      sourceId,
      ...(processed === undefined
        ? {}
        : { processedPublicationId: processed.publicationId }),
      behind: false,
    };
  }

  const behind = processed?.publicationId !== latestReady.publicationId;
  const lagMs =
    processed?.producedAt === undefined
      ? undefined
      : elapsedMs(processed.producedAt, latestReady.producedAt);

  return {
    sourceId,
    ...(processed === undefined
      ? {}
      : { processedPublicationId: processed.publicationId }),
    latestReadyPublicationId: latestReady.publicationId,
    behind,
    ...(lagMs === undefined ? {} : { freshnessLagMs: lagMs }),
  };
}

/**
 * How long a Scope may sit in `pending_registry` before the lane is degraded.
 *
 * Five minutes, from `registry-reachability-v1`. The threshold is a constant
 * rather than an argument so that two callers cannot disagree about what the
 * operating standard says, and it is exported so a test can state the boundary
 * instead of hard-coding a number that would silently stop matching.
 */
export const STALE_PENDING_REGISTRY_MS = 5 * 60 * 1_000;

/**
 * Scope versions that have been waiting to be processed for too long.
 *
 * `pending_registry` on its own is not a problem — a Publication that landed
 * seconds ago is supposed to be there. It becomes one when it stays, which is
 * why the judgement needs a clock and not just a count.
 *
 * A Scope with no `stateSince` is left out rather than assumed stale. The
 * timestamp comes from the audit trail, so its absence means nothing has been
 * recorded about the Scope yet, and treating that as five minutes elapsed would
 * report a lane as degraded on the strength of a missing value.
 */
export function stalePendingRegistryScopes(
  report: ReachabilityReport,
  thresholdMs: number = STALE_PENDING_REGISTRY_MS,
): readonly ScopeReachability[] {
  return report.scopes.filter((scope) => {
    if (scope.state !== "pending_registry" || scope.stateSince === undefined) {
      return false;
    }
    const waited = elapsedMs(scope.stateSince, report.generatedAt);
    return waited !== undefined && waited > thresholdMs;
  });
}

/**
 * Milliseconds from `from` to `to`, or `undefined` when either is unusable.
 *
 * Negative differences are dropped rather than reported. A consumed Publication
 * that is newer than the newest ready one is not a lag, it is a contradiction —
 * a retry produced later than its successor, say — and a negative "how stale"
 * would be read as a clock problem in whatever displays it.
 */
function elapsedMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

/**
 * One Source's position, as the report publishes it.
 *
 * Exactly the three fields the design names, and no more. The delay travels in
 * `sourceFreshnessLags` instead of here because the design keeps the two apart —
 * §6 speaks of "Source freshness lag와 sourceCheckpoints" as two places a new
 * Publication's unprocessed state shows up, not one. Folding the delay into the
 * position would also mean a consumer that wants only the watermark has to read
 * past a judgement it did not ask for.
 */
export interface SourceCheckpoint {
  readonly sourceId: SourceId;
  readonly processedPublicationId?: PublicationId | undefined;
  readonly latestReadyPublicationId?: PublicationId | undefined;
}

/** One Source's delay, keyed by the same id as its checkpoint. */
export interface SourceFreshnessLag {
  readonly sourceId: SourceId;
  readonly behind: boolean;
  readonly freshnessLagMs?: number | undefined;
}

/** Splits one judgement into the two shapes the report publishes. */
export function toSourceCheckpoint(lag: SourceProcessingLag): SourceCheckpoint {
  return {
    sourceId: lag.sourceId,
    ...(lag.processedPublicationId === undefined
      ? {}
      : { processedPublicationId: lag.processedPublicationId }),
    ...(lag.latestReadyPublicationId === undefined
      ? {}
      : { latestReadyPublicationId: lag.latestReadyPublicationId }),
  };
}

export function toSourceFreshnessLag(lag: SourceProcessingLag): SourceFreshnessLag {
  return {
    sourceId: lag.sourceId,
    behind: lag.behind,
    ...(lag.freshnessLagMs === undefined ? {} : { freshnessLagMs: lag.freshnessLagMs }),
  };
}
