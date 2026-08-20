import {
  judgeSourceProcessingLag,
  type SourceConsumptionSighting,
  type SourceProcessingLag,
} from "../domain/processing-lag.js";
import {
  collectScopeObservations,
  judgeScopeReachability,
  summarizeScopeReachability,
  toScopeDecisions,
  type ReachabilityReport,
  type ScopeObservation,
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
   * How far each Source has been published, and what those Publications carry.
   *
   * Required, and it was optional here for a while on the grounds that the
   * reachability judgement needs only committed Card state. That was wrong:
   * `pending_registry` is one of the six states and the first in the priority
   * order, and a Scope waiting to be consumed has no Card Version to be observed
   * through — it can only be found by reading Ingestion. A report assembled
   * without this reader is not a report with a missing extra, it is one that
   * cannot produce a state the design defines.
   */
  readonly publications: SourcePublicationFeed & PublicationRepository;
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

  const sightingsBySource = await Promise.all(
    cursors.map(async (cursor) => sight(ports, cursor)),
  );
  const lags = sightingsBySource.map(judgeSourceProcessingLag);
  const waiting = await awaitingRegistry(ports, lags, observations);

  return summarizeScopeReachability(
    ports.clock.now(),
    [...observations, ...waiting].map(judgeScopeReachability),
    lags,
  );
}

/**
 * Scopes that Ingestion has published and Registry has not consumed yet.
 *
 * Without this the `pending_registry` state cannot occur. Every other state is
 * derived from `card_versions`, so a Scope only becomes visible once Registry has
 * already turned it into a Card Version — which is precisely the condition of
 * *not* being pending. The state existed in the type and in the priority order
 * and nothing could ever be in it.
 *
 * Read from the newest ready Publication of each Source that is behind. That
 * covers the state's purpose — knowing that indexed knowledge is waiting — without
 * walking the chain: the gap between cursor and newest may hold more Publications,
 * and each would cost another query to answer a question the newest one already
 * answers.
 *
 * A Scope already observed through a Card Version is left alone. An immutable
 * Scope carries forward unchanged into later Publications, so the same
 * `(scopeId, scopeVersion)` can appear in one that has not been consumed while a
 * Card is already serving it. Reporting that as pending would move a `reachable`
 * Scope back to waiting, which the design explicitly forbids.
 */
async function awaitingRegistry(
  ports: BuildReachabilityReportPorts,
  lags: readonly SourceProcessingLag[],
  observed: readonly ScopeObservation[],
): Promise<readonly ScopeObservation[]> {
  const feed = ports.publications;
  const seen = new Set(
    observed.map(
      (observation) =>
        `${observation.reference.scopeId}\u0000${observation.reference.scopeVersion}`,
    ),
  );
  const waiting: ScopeObservation[] = [];

  for (const lag of lags.filter((each) => each.behind)) {
    const publication = await feed.latestForSource(lag.sourceId);
    if (publication === undefined) {
      continue;
    }
    // Iterated defensively. The record is parsed on the way into Ingestion's
    // store, but this report is a read of someone else's storage and a shape it
    // cannot walk must not take the whole report down — an operator asking why a
    // Source is behind would get a stack trace instead of the answer.
    for (const unit of publication.knowledgeUnits ?? []) {
      for (const scope of unit.publishedScopes ?? []) {
        const key = `${scope.scopeId}\u0000${scope.scopeVersion}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        waiting.push({
          reference: { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion },
          // Known without a second read: this Scope was found by asking for that
          // Source's newest Publication in the first place.
          sourceId: lag.sourceId,
          introducedByPublicationId: publication.publicationId,
          lastSeenPublicationId: publication.publicationId,
          processed: false,
          // The wait is measured from when Ingestion made it available, which is
          // what the five-minute standard is about — not from when we looked.
          readySince: publication.producedAt,
          carriers: [],
          decisions: [],
        });
      }
    }
  }

  return waiting;
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
  const [latest, processed] = await Promise.all([
    feed.latestForSource(cursor.sourceId),
    feed.findById(cursor.publicationId),
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
