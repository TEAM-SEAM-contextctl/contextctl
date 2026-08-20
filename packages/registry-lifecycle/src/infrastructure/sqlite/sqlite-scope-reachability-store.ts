import type { DatabaseSync } from "node:sqlite";

import type { CardValidationState } from "../../domain/card-version.js";
import type { LifecycleEvent } from "../../domain/lifecycle-event.js";
import type { RetrievalScope } from "../../domain/retrieval-scope.js";
import type { ScopeSighting } from "../../domain/scope-reachability.js";
import type { ScopeReachabilityStore } from "../../ports/scope-reachability-store.js";
import { readJson, readOptionalText, readText, RegistryRowError, type SqlRow } from "./row-values.js";

/** Operator decisions. Other event kinds say nothing about exposure. */
const decisionKinds = [
  "card_version_promoted",
  "card_version_refused",
  "card_withdrawn",
] as const;

export class SqliteScopeReachabilityStore implements ScopeReachabilityStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async listScopeSightings(): Promise<readonly ScopeSighting[]> {
    // Every version, not just the current one, and one join rather than a
    // query per Card. The join carries the current pointer so the caller can
    // tell a serving version from a superseded one without asking again.
    const rows = this.#database
      .prepare(
        // Left join to the claim record for the Source. It stores `source_id`
        // beside every Publication Registry consumed, so the Source of a Scope
        // costs a join in this database rather than a fetch per Publication
        // across the Ingestion boundary. Left rather than inner: a Card Version
        // written before that column existed would otherwise vanish from the
        // report, and a Scope missing from a reachability report is the one
        // failure this report exists to prevent.
        `SELECT
           v.version_id, v.card_id, v.publication_id, v.scopes,
           v.validation_state, v.created_at, c.current_version_id,
           k.source_id
         FROM card_versions v
         JOIN cards c ON c.card_id = v.card_id
         LEFT JOIN consumer_checkpoints k
           ON k.publication_id = v.publication_id
         ORDER BY v.append_order`,
      )
      .all() as SqlRow[];

    return rows.flatMap((row) => {
      const versionId = readText(row, "version_id");
      const carrier = {
        cardId: readText(row, "card_id"),
        versionId,
        publicationId: readText(row, "publication_id"),
        // Falls back to the Publication id when no claim row names the Source.
        // Reachability without a Source is unusable to an operator, and the
        // Publication is the one identifier that is always present and does at
        // least point at something they can look up.
        sourceId:
          readOptionalText(row, "source_id") ?? readText(row, "publication_id"),
        validationState: readValidationState(row),
        isCurrent: readOptionalText(row, "current_version_id") === versionId,
        createdAt: readText(row, "created_at"),
      };

      // A Card Version may carry several Scopes, and each Scope version is
      // judged on its own, so they are flattened here rather than nested.
      return readJson<readonly RetrievalScope[]>(row, "scopes").map(
        (scope) => ({ ...carrier, scope }),
      );
    });
  }

  async listOperatorDecisions(): Promise<readonly LifecycleEvent[]> {
    // Filtered in SQL: an impact assessment or a version being added decides
    // nothing about exposure and never needs to be read to answer this.
    const placeholders = decisionKinds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT * FROM lifecycle_events
         WHERE kind IN (${placeholders})
         ORDER BY append_order`,
      )
      .all(...decisionKinds) as SqlRow[];

    return rows.map(toLifecycleEvent);
  }
}

function toLifecycleEvent(row: SqlRow): LifecycleEvent {
  const event = {
    id: readText(row, "event_id"),
    cardId: readText(row, "card_id"),
    kind: readText(row, "kind"),
    occurredAt: readText(row, "occurred_at"),
    ...readJson<Record<string, unknown>>(row, "payload"),
  };
  return event as unknown as LifecycleEvent;
}

const validationStates: readonly CardValidationState[] = [
  "draft",
  "validated",
  "rejected",
];

function readValidationState(row: SqlRow): CardValidationState {
  const value = readText(row, "validation_state");
  const state = validationStates.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new RegistryRowError("validation_state", value);
  }
  return state;
}
