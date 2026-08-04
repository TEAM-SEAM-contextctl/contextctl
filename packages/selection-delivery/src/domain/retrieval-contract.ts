import type {
  ApprovedCard,
  ApprovedScope,
  ApprovedScopeReference,
} from "./card-catalog.js";
import { SelectionScopeInvariantError } from "./errors.js";

/**
 * What this domain hands back for a consumer-owned source: coordinates the
 * consumer can verify and then execute itself.
 *
 * ADR 0001 draws the output boundary here. We never build SQL, never open a
 * connection, and never call an endpoint; we say precisely which table, which
 * columns, which method and which path a selected Scope authorises, and the
 * consumer takes it from there. Everything on these records is transcribed from
 * an already approved Scope, so a contract can never widen what was approved.
 */

/**
 * A verifiable coordinate into a consumer's table.
 *
 * `allowedOperations` is the "허용 연산" ADR 0001 requires to be stated rather
 * than assumed. It is a fixed `["select"]` tuple, not a configurable list: the
 * product reads, and a write operation would drag the whole execution surface
 * ADR 0001 refuses back into this domain.
 */
export interface SqlRetrievalContract {
  readonly kind: "sql";
  readonly cardId: string;
  readonly versionId: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly allowedOperations: readonly ["select"];
}

/** A verifiable coordinate into a consumer's HTTP endpoint. Never called here. */
export interface HttpRetrievalContract {
  readonly kind: "http";
  readonly cardId: string;
  readonly versionId: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly method: string;
  readonly path: string;
}

export type RetrievalContract = SqlRetrievalContract | HttpRetrievalContract;

/**
 * The contract-relevant projection of one admitted Card.
 *
 * Narrower than `ApprovedCard` on purpose: meaning and policy decide whether a
 * Card is admitted, and that decision is already made by the time contracts are
 * built. An `ApprovedCard` still satisfies this shape structurally.
 */
export type ContractSource = Pick<ApprovedCard, "cardId" | "versionId" | "scopes">;

/**
 * Turns the admitted Cards into the retrieval contracts their Scopes authorise.
 *
 * Managed document Scopes produce nothing: a document is answered with evidence
 * assembled from our own index (ADR 0002), not with a coordinate the consumer
 * executes, so it leaves this path silently rather than by error.
 *
 * The ordering is versionId ascending, then scopeId ascending inside one Card,
 * so the same admitted set always yields the same contract list. The caller's
 * arrays are never read back out by reference or reordered.
 */
export function buildRetrievalContracts(
  admitted: readonly ContractSource[],
): readonly RetrievalContract[] {
  const contracts: RetrievalContract[] = [];

  for (const source of admitted) {
    for (const scope of source.scopes) {
      const contract = toContract(source, scope);
      if (contract !== undefined) {
        contracts.push(contract);
      }
    }
  }

  return contracts.sort(compareContracts);
}

function toContract(
  source: ContractSource,
  scope: ApprovedScope,
): RetrievalContract | undefined {
  switch (scope.kind) {
    case "managed_document":
      return undefined;
    case "sql_source":
      return {
        kind: "sql",
        cardId: source.cardId,
        versionId: source.versionId,
        scopeRef: scope.reference,
        connector: scope.connector,
        table: scope.table,
        // Copied rather than aliased: the contract is handed to a consumer, and
        // it must not be a live window onto the catalog's own array.
        columns: [...scope.columns],
        allowedOperations: ["select"],
      };
    case "http_source":
      return {
        kind: "http",
        cardId: source.cardId,
        versionId: source.versionId,
        scopeRef: scope.reference,
        connector: scope.connector,
        method: scope.method,
        path: scope.path,
      };
    default:
      return refuseUnknownScope(scope);
  }
}

/**
 * Unreachable for any `ApprovedScope`, which is what the `never` binding
 * asserts: adding a fourth Scope kind breaks the build here instead of silently
 * dropping that kind from every contract list. At runtime it is reachable only
 * through an adapter that produced data outside the declared union, and that is
 * a corrupted read model, not an unsupported feature.
 */
function refuseUnknownScope(scope: never): never {
  const { kind } = scope as { readonly kind: unknown };

  throw new SelectionScopeInvariantError(
    `scope kind ${String(kind)} cannot be resolved into a retrieval contract`,
  );
}

function compareContracts(
  left: RetrievalContract,
  right: RetrievalContract,
): number {
  // `<` / `>` rather than `localeCompare`: the ordering has to be identical on
  // every machine, and `localeCompare` resolves against the runtime locale.
  if (left.versionId !== right.versionId) {
    return left.versionId < right.versionId ? -1 : 1;
  }
  if (left.scopeRef.scopeId !== right.scopeRef.scopeId) {
    return left.scopeRef.scopeId < right.scopeRef.scopeId ? -1 : 1;
  }
  return 0;
}
