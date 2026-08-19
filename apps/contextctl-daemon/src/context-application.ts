import {
  ManagedDocumentSearchError,
  type BatchManagedDocumentSearchCommand,
  type BatchManagedDocumentSearchItem,
  type BatchManagedDocumentSearchTarget,
  type DocumentSearchHit,
} from "@contextctl/ingestion-indexing";
import {
  assembleContext,
  narrowContextBudget,
  selectContext,
  type ApprovedCardCatalog,
  type ContextResolution,
  type ContextBudget,
  type ManagedDocumentResolutionTarget,
  type ManagedResolutionOutcome,
  type ResolveContextApplication,
  type ResolveContextRequest,
  type ResolvedDocumentChunk,
  type SelectContextOptions,
  type SemanticSelectionPorts,
} from "@contextctl/selection-delivery";

/**
 * The single method of `ManagedDocumentSearch` this application calls.
 *
 * Named structurally so a test can stand in a search that fails with a chosen
 * code. `ManagedDocumentSearch` carries private fields, so depending on the
 * class itself would make every failure-mapping test go through a cast, and a
 * cast is exactly the thing that stops proving the mapping is reachable.
 */
export interface ManagedDocumentSearchPort {
  searchBatch(
    command: BatchManagedDocumentSearchCommand,
  ): Promise<readonly BatchManagedDocumentSearchItem[]>;
}

export interface DaemonContextApplicationDependencies {
  readonly catalog: ApprovedCardCatalog;
  readonly search: ManagedDocumentSearchPort;
  /**
   * The isolation key every search this application makes is performed under.
   *
   * It is configuration, and it is added here rather than carried in from
   * anywhere upstream. Ingestion decided that a publication's `securityDomain`
   * is never serialized into a Published Scope, so it is absent from Registry's
   * read model and from Selection's, and no honest derivation path exists — a
   * Card that could name its own isolation key would be a Card that could widen
   * its own access. Declared by the Composition Root instead, a wrong value
   * fails loudly and specifically as `security_domain_mismatch`.
   */
  readonly securityDomain: string;
  /**
   * The Card embedding port, its candidate index and the profile both are keyed
   * on. Absent for a composition with no Card vectors, which then answers under
   * `lexical_degraded` and says so in the response.
   *
   * It is one field rather than three because the three are meaningless apart:
   * an index prepared under one profile and searched with vectors from another
   * is not a degraded ranking, it is a wrong one.
   */
  readonly semantic?: SemanticSelectionPorts;
  /** Selection policy every request runs under; a caller may not state it. */
  readonly selection?: SelectContextOptions;
  /**
   * The context ceiling this deployment emits under. A request may narrow it,
   * never widen it — `narrowContextBudget` is where that rule lives.
   */
  readonly budget?: ContextBudget;
}

/**
 * Runs one query across all three steps of the pipeline.
 *
 * This class is the coordinator the split created, and it exists here rather
 * than in Selection or Delivery because it is the only place entitled to be
 * both: it names Indexing and it names Selection, which no domain package may
 * do. The Composition Root has always been where a port meets an
 * implementation; what is new is that the sequencing lives here too.
 *
 * The sequence is fixed. Selection produces a plan without touching an index.
 * The plan's targets are translated field by field into one batch command, with
 * the security domain added from this object's own configuration. The batch is
 * executed once. The results are projected back into outcomes, and Delivery
 * assembles them. Nothing in the first step can cause a read, and nothing in
 * the last one can.
 */
export class DaemonContextApplication implements ResolveContextApplication {
  readonly #catalog: ApprovedCardCatalog;
  readonly #search: ManagedDocumentSearchPort;
  readonly #securityDomain: string;
  readonly #semantic: SemanticSelectionPorts | undefined;
  readonly #selection: SelectContextOptions;
  readonly #budget: ContextBudget | undefined;

  constructor(dependencies: DaemonContextApplicationDependencies) {
    this.#catalog = dependencies.catalog;
    this.#search = dependencies.search;
    this.#securityDomain = dependencies.securityDomain;
    this.#semantic = dependencies.semantic;
    this.#selection = dependencies.selection ?? {};
    this.#budget = dependencies.budget;
  }

  async resolveContext(
    request: ResolveContextRequest,
  ): Promise<ContextResolution> {
    // Before the catalog is touched, and before any read is planned. A request
    // that misstates its ceiling has not asked a question we can answer, so
    // refusing it here costs no access at all — and it is what makes the
    // refusal a request-level `ResolveContextError` rather than a per-item
    // failure inside an answer that should never have been assembled.
    const budget = narrowContextBudget(this.#budget, request.maxContextCharacters);

    const plan = await selectContext(
      {
        catalog: this.#catalog,
        // Spread rather than assigned, because `exactOptionalPropertyTypes`
        // makes `{ semantic: undefined }` different from an absent key, and only
        // the absent key selects the lexical composition.
        ...(this.#semantic === undefined ? {} : { semantic: this.#semantic }),
      },
      request.query,
      this.#selection,
    );
    const outcomes = await this.#executeManagedTargets(
      plan.query,
      plan.managedTargets,
    );

    return assembleContext(plan, outcomes, { budget });
  }

  /**
   * Executes every managed read the plan named, in one batch.
   *
   * An empty plan skips the search entirely rather than sending an empty batch.
   * That is not an optimisation: `searchBatch` refuses a command with no
   * targets as `invalid_request`, so sending one would turn "this query
   * selected no documents" — an ordinary and correct outcome — into a failure
   * report, and every item in the answer would carry a code describing a
   * request the caller never made.
   */
  async #executeManagedTargets(
    queryText: string,
    targets: readonly ManagedDocumentResolutionTarget[],
  ): Promise<readonly ManagedResolutionOutcome[]> {
    if (targets.length === 0) {
      return [];
    }

    const command: BatchManagedDocumentSearchCommand = {
      queryText,
      // The one field that is added rather than translated, and the only field
      // on the command that does not come from the plan. See
      // `securityDomain` on the dependencies.
      securityDomain: this.#securityDomain,
      targets: targets.map(toSearchTarget),
    };

    let items: readonly BatchManagedDocumentSearchItem[];
    try {
      items = await this.#search.searchBatch(command);
    } catch (cause: unknown) {
      // A throw out of `searchBatch` is a whole-batch rejection — a malformed
      // command, a cancelled signal — so every target failed, and each one says
      // so with the code the search itself used. Failing the resolution instead
      // would discard the SQL and HTTP items the same query selected, which
      // were never affected by a document search that did not run.
      const failure = toManagedFailure(cause);
      return targets.map((target) => ({
        targetKey: target.targetKey,
        status: "failed",
        failure,
      }));
    }

    return projectSearchItems(items, targets);
  }
}

/**
 * One target, copied field by field.
 *
 * Translation is not the place to recover missing information. `scopeId`,
 * `scopeVersion`, `targetKey` and `limit` are carried across unchanged, and
 * there is deliberately no catalog lookup here that could find a similar Scope
 * or a physical binding and fill the command in with it: a command completed
 * that way would search something the Card never authorised while reporting the
 * Card's own Scope reference back to the consumer.
 */
function toSearchTarget(
  target: ManagedDocumentResolutionTarget,
): BatchManagedDocumentSearchTarget {
  return {
    targetKey: target.targetKey,
    scopeRef: {
      scopeId: target.scopeRef.scopeId,
      scopeVersion: target.scopeRef.scopeVersion,
    },
    limit: target.limit,
  };
}

/**
 * Projects what the search answered into what Delivery assembles from.
 *
 * A target the search did not answer for at all becomes a failure rather than
 * an empty success. `searchBatch` returns one item per target, so a gap means
 * the contract was broken; reporting it as "the index answered and had nothing
 * to say" would tell a consumer the document is empty when nobody looked.
 */
function projectSearchItems(
  items: readonly BatchManagedDocumentSearchItem[],
  targets: readonly ManagedDocumentResolutionTarget[],
): readonly ManagedResolutionOutcome[] {
  const byTargetKey = new Map(items.map((item) => [item.targetKey, item]));

  return targets.map((target): ManagedResolutionOutcome => {
    const item = byTargetKey.get(target.targetKey);
    if (item === undefined) {
      return {
        targetKey: target.targetKey,
        status: "failed",
        failure: {
          stage: "managed_search",
          code: "unexpected_failure",
          retriable: false,
        },
      };
    }
    if (item.status === "failed") {
      return {
        targetKey: target.targetKey,
        status: "failed",
        // The code and the retriable flag cross unchanged. Indexing's error
        // vocabulary is Indexing's to version, and folding seventeen codes into
        // a smaller set of our own — as the retriever port used to — replaced a
        // precise statement with a guess. Delivery checks the code is a
        // printable token and prints it; nothing in between reinterprets it.
        failure: {
          stage: "managed_search",
          code: item.failure.code,
          retriable: item.failure.retriable,
        },
      };
    }
    return {
      targetKey: target.targetKey,
      status: "fulfilled",
      chunks: item.hits.map(toResolvedChunk),
    };
  });
}

/**
 * One hit, copied field by field, rank included.
 *
 * `rank` crosses as the position it is. The retriever port this replaced
 * manufactured a `1 / rank` score here because Selection's ranking band was
 * stated on [0, 1] and Indexing withholds provider similarity — so a number
 * was invented that looked like a similarity and was not one. Fusion in
 * `context-assembly.ts` consumes positions directly now, and the invention has
 * no remaining purpose.
 */
function toResolvedChunk(hit: DocumentSearchHit): ResolvedDocumentChunk {
  return {
    rank: hit.rank,
    chunkId: hit.chunkId,
    chunkRevisionId: hit.chunkRevisionId,
    semanticUnitId: hit.semanticUnitId,
    documentId: hit.documentId,
    text: hit.text,
    contentDigest: hit.contentDigest,
  };
}

/**
 * The failure a whole-batch throw stands for.
 *
 * `unexpected_failure` for anything that is not the search's own error, which
 * is the code Indexing itself uses for the same situation one layer down. It is
 * not a diagnosis and does not pretend to be one — inferring `index_unavailable`
 * from an arbitrary exception would be a claim about infrastructure nobody
 * checked.
 */
function toManagedFailure(cause: unknown): {
  readonly stage: "managed_search";
  readonly code: string;
  readonly retriable: boolean;
} {
  if (cause instanceof ManagedDocumentSearchError) {
    return {
      stage: "managed_search",
      code: cause.code,
      retriable: cause.retriable,
    };
  }
  return {
    stage: "managed_search",
    code: "unexpected_failure",
    retriable: false,
  };
}
