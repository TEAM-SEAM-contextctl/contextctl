import {
  assembleContext,
  InMemoryCardCatalog,
  narrowContextBudget,
  selectContext,
  type ApprovedCard,
  type ApprovedCardCatalog,
  type AssembleContextOptions,
  type ContextResolution,
  type ManagedDocumentResolutionTarget,
  type ManagedResolutionOutcome,
  type ResolveContextApplication,
  type ResolveContextRequest,
  type SelectContextOptions,
} from "../../src/index.js";
import {
  FixtureManagedExecutor,
  type FixtureChunk,
} from "./managed-execution.fixture.js";

/**
 * A whole pipeline behind the one interface a query surface may hold.
 *
 * The daemon assembles the real one out of Registry's catalog and Indexing's
 * batch search; this assembles the same three steps out of a card list and an
 * in-memory executor, so a test about a protocol surface exercises selection,
 * execution and assembly in the order the daemon runs them without standing in
 * a mock for any of the three.
 *
 * It also demonstrates the property the split exists for: a surface receives
 * this and nothing else, so no test here can reach a catalog or an executor
 * through the object it was handed.
 */
export interface FixtureContextApplicationOptions {
  readonly cards?: readonly ApprovedCard[];
  /** Chunks per `scopeId`. A Scope absent from it fails rather than answers. */
  readonly chunks?: Readonly<Record<string, readonly FixtureChunk[]>>;
  /** Replaces the executor entirely, for a test about a specific outcome. */
  readonly execute?: (
    queryText: string,
    targets: readonly ManagedDocumentResolutionTarget[],
  ) => readonly ManagedResolutionOutcome[];
  readonly catalog?: ApprovedCardCatalog;
  readonly selection?: SelectContextOptions;
  readonly budget?: AssembleContextOptions["budget"];
}

export function createFixtureContextApplication(
  options: FixtureContextApplicationOptions = {},
): ResolveContextApplication {
  const catalog =
    options.catalog ?? new InMemoryCardCatalog(options.cards ?? []);
  const executor = new FixtureManagedExecutor(options.chunks ?? {});
  const execute =
    options.execute ??
    ((queryText: string, targets: readonly ManagedDocumentResolutionTarget[]) =>
      executor.execute(queryText, targets));

  return {
    async resolveContext(
      request: ResolveContextRequest,
    ): Promise<ContextResolution> {
      // Ahead of the catalog read, exactly where the daemon applies it: a test
      // about a surface's error mapping has to meet the same ordering the
      // production composition has, or it would prove a refusal the real
      // pipeline reaches only after an access it should never have made.
      const budget = narrowContextBudget(
        options.budget,
        request.maxContextCharacters,
      );
      const plan = await selectContext(
        { catalog },
        request.query,
        options.selection ?? {},
      );
      const outcomes = execute(plan.query, plan.managedTargets);

      return assembleContext(plan, outcomes, { budget });
    },
  };
}
