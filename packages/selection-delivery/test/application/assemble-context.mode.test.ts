import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/application/assemble-context.js";
import { selectContext } from "../../src/application/select-context.js";
import type { SelectionPlan } from "../../src/domain/selection-plan.js";
import { InMemoryCardCandidateIndexStore } from "../../src/infrastructure/in-memory-card-candidate-index-store.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  ConceptCardEmbeddingAdapter,
  createLeavePolicyCard,
  LEAVE_CONCEPTS,
  SYNONYM_QUERY,
  TEST_CARD_PROFILE,
} from "../fixtures/card-embedding.fixture.js";

function planFor(semantic: boolean): Promise<SelectionPlan> {
  const catalog = new InMemoryCardCatalog([createLeavePolicyCard()]);

  return semantic
    ? selectContext(
        {
          catalog,
          semantic: {
            embedding: new ConceptCardEmbeddingAdapter(LEAVE_CONCEPTS),
            index: new InMemoryCardCandidateIndexStore(),
            profile: TEST_CARD_PROFILE,
          },
        },
        SYNONYM_QUERY,
      )
    : selectContext({ catalog }, SYNONYM_QUERY);
}

describe("the scoring family a response reports", () => {
  it("reports hybrid and its paired scoring version together", async () => {
    const resolution = assembleContext(await planFor(true), []);

    expect(resolution.selection.mode).toBe("hybrid");
    expect(resolution.policy.scoring).toBe("selection-hybrid-v1");
  });

  it("reports lexical_degraded and its paired scoring version together", async () => {
    const resolution = assembleContext(await planFor(false), []);

    expect(resolution.selection.mode).toBe("lexical_degraded");
    expect(resolution.policy.scoring).toBe("selection-lexical-v1");
  });

  /**
   * The mode is transcribed from the plan rather than re-derived here, and this
   * is what makes that observable.
   *
   * Every number in this plan came from a lexical scoring run, so any rule that
   * inferred the mode from the candidates would answer `lexical_degraded`. Only
   * the step that held the ports knows which family produced them.
   */
  it("takes the mode from the plan rather than inferring it from the scores", async () => {
    const lexicalPlan = await planFor(false);
    const relabelled: SelectionPlan = {
      ...lexicalPlan,
      summary: { ...lexicalPlan.summary, mode: "hybrid" },
    };

    expect(assembleContext(relabelled, []).selection.mode).toBe("hybrid");
    expect(assembleContext(relabelled, []).policy.scoring).toBe(
      "selection-hybrid-v1",
    );
  });

  it("keeps the other four policy versions unchanged across modes", async () => {
    const hybrid = assembleContext(await planFor(true), []).policy;
    const lexical = assembleContext(await planFor(false), []).policy;

    // Only `scoring` moves with the mode. A consumer comparing two answers has
    // to be able to see that ranking, planning, fusion and assembly did not.
    expect(hybrid.ranking).toBe(lexical.ranking);
    expect(hybrid.planning).toBe(lexical.planning);
    expect(hybrid.fusion).toBe(lexical.fusion);
    expect(hybrid.assembly).toBe(lexical.assembly);
    expect(hybrid.payloadSchemaVersion).toBe(3);
  });
});
