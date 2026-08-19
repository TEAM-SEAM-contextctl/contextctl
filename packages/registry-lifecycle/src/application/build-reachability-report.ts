import {
  judgeSourceProcessingLag,
  type SourceConsumptionSighting,
} from "../domain/processing-lag.js";
import {
  collectScopeObservations,
  judgeScopeReachability,
  summarizeScopeReachability,
  toScopeDecisions,
  type ReachabilityReport,
} from "../domain/scope-reachability.js";
import type { Clock } from "../ports/clock.js";
import type { ConsumerCheckpointStore } from "../ports/consumer-checkpoint-store.js";
import type {
  PublicationRepository,
  SourcePublicationFeed,
} from "../ports/publication-repository.js";
import type { ScopeReachabilityStore } from "../ports/scope-reachability-store.js";

export interface BuildReachabilityReportPorts {
  readonly scopes: ScopeReachabilityStore;
  readonly checkpoints: ConsumerCheckpointStore;
  readonly clock: Clock;
  /**
   * How far each Source has been published, for measuring the delay.
   *
   * Optional, and absent is a legitimate composition rather than a degraded one:
   * the reachability judgement itself needs only committed Card state, so a
   * caller that wants the states and not the delay should not have to assemble a
   * publication reader to get them. When it is absent every Source reports
   * `behind: false` with no lag, which is the same shape as "caught up" — and
   * that is why the CLI says which composition it ran under rather than letting
   * a missing reader read as a healthy one.
   */
  readonly publications?: SourcePublicationFeed & Partial<PublicationRepository>;
}

/**
 * Reports whether each published Scope version can still be reached by a query.
 *
 * Nothing is stored. The verdict is derived from committed Card state and the
 * audit trail on every call, so it cannot drift from the catalog the way a
 * second copy of the state would: a Scope is never reported reachable while it
 * is also awaiting approval, because both answers come from one read.
 *
 * Reading is all this does. An `orphaned` Scope stays out of the catalog and
 * out of every search; naming it is the point, and deciding what to do about
 * it belongs to an operator.
 */
export async function buildReachabilityReport(
  ports: BuildReachabilityReportPorts,
): Promise<ReachabilityReport> {
  const [sightings, decisions, cursors] = await Promise.all([
    ports.scopes.listScopeSightings(),
    ports.scopes.listOperatorDecisions(),
    ports.checkpoints.listCursors(),
  ]);

  const observations = collectScopeObservations(
    sightings,
    toScopeDecisions(decisions),
  );

  return summarizeScopeReachability(
    ports.clock.now(),
    observations.map(judgeScopeReachability),
    await Promise.all(
      cursors.map(async (cursor) => judgeSourceProcessingLag(await sight(ports, cursor))),
    ),
  );
}

/**
 * Reads both ends of one Source's chain, as far as the composition allows.
 *
 * The two reads are deliberately independent. A `producedAt` for the consumed
 * Publication requires fetching it by id, and that record can be gone or the
 * reader may not be wired at all; when either side is missing the lag is reported
 * as unknown rather than as zero. Zero would say "caught up", which is the one
 * answer a missing read must not produce.
 */
async function sight(
  ports: BuildReachabilityReportPorts,
  cursor: { readonly sourceId: string; readonly publicationId: string },
): Promise<SourceConsumptionSighting> {
  const feed = ports.publications;
  const processedSighting = { publicationId: cursor.publicationId };
  if (feed === undefined) {
    // The watermark is Registry's own state, so it is reported either way. Only
    // the delay needs Ingestion.
    return { sourceId: cursor.sourceId, processed: processedSighting };
  }

  const [latest, processed] = await Promise.all([
    feed.latestForSource(cursor.sourceId),
    feed.findById?.(cursor.publicationId),
  ]);

  return {
    sourceId: cursor.sourceId,
    processed:
      processed === undefined
        ? processedSighting
        : { publicationId: cursor.publicationId, producedAt: processed.producedAt },
    ...(latest === undefined
      ? {}
      : {
          latestReady: {
            publicationId: latest.publicationId,
            producedAt: latest.producedAt,
          },
        }),
  };
}
