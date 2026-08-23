import { describe, expect, it } from "vitest";

import {
  judgeLanes,
  type LaneName,
  type LaneStatus,
  type StatusObservation,
} from "../../src/cli/status.js";
import type { EmbeddingObservation } from "../../src/embedding/readiness.js";

/**
 * What an empty artifact directory means, now that it can mean two things.
 *
 * Before the layers could be configured apart there was one answer — a local
 * model or nothing — so "no assets" and "unusable" were the same observation.
 * A deployment that reaches a hosted provider for both layers has no model to
 * install, and reporting it unhealthy would tell an operator to download 390MB
 * their daemon never opens. These cases pin which of the two an empty directory
 * is.
 */

function observation(
  embedding: EmbeddingObservation,
  assets: StatusObservation["assets"],
): StatusObservation {
  return {
    assets,
    vectorIndex: { status: "configured", endpoint: "http://localhost:6333/" },
    stateReadiness: { status: "ready" },
    registry: {
      status: "read",
      behindSources: [],
      stalePendingScopeCount: 0,
      approvedCardCount: 3,
    },
    ingestion: {
      status: "read",
      probedSources: ["src_payments"],
      incompleteSources: [],
    },
    embedding,
  };
}

const MISSING_ASSETS: StatusObservation["assets"] = {
  status: "unavailable",
  detail: "임베딩 자산이 설치되지 않았습니다.",
};

function statusOf(
  report: ReturnType<typeof judgeLanes>,
  lane: LaneName,
): LaneStatus {
  const verdict = report.lanes.find((candidate) => candidate.lane === lane);
  if (verdict === undefined) throw new Error(`no verdict for ${lane}`);
  return verdict.status;
}

describe("embedding readiness", () => {
  it("serves with no assets when nothing required needs them", () => {
    const report = judgeLanes(
      observation(
        {
          status: "composed",
          documentMode: "remote",
          cardMode: "remote",
          requiresLocalAssets: false,
          restoredProfiles: [],
        },
        MISSING_ASSETS,
      ),
    );

    expect(statusOf(report, "selection_assets")).toBe("ready");
    expect(statusOf(report, "resolve")).toBe("ready");
    expect(report.serviceable).toBe(true);
  });

  it("does not tell an operator to install what they do not need", () => {
    const report = judgeLanes(
      observation(
        {
          status: "composed",
          documentMode: "remote",
          cardMode: "remote",
          requiresLocalAssets: false,
          restoredProfiles: [],
        },
        MISSING_ASSETS,
      ),
    );

    const assets = report.lanes.find(
      (verdict) => verdict.lane === "selection_assets",
    );
    expect(assets?.detail).not.toContain("install-assets");
  });

  it("still blocks when a required binding is local", () => {
    const report = judgeLanes(
      observation(
        {
          status: "composed",
          documentMode: "local",
          cardMode: "remote",
          requiresLocalAssets: true,
          restoredProfiles: [],
        },
        MISSING_ASSETS,
      ),
    );

    expect(statusOf(report, "selection_assets")).toBe("not_ready");
    expect(statusOf(report, "resolve")).toBe("not_ready");
  });

  it("blocks when both layers are remote but a Card still reaches a local Scope", () => {
    // The migration tail. Configuration says remote on both sides and the
    // deployment still cannot delete the model.
    const report = judgeLanes(
      observation(
        {
          status: "composed",
          documentMode: "remote",
          cardMode: "remote",
          requiresLocalAssets: true,
          restoredProfiles: ["document-granite-97m-multilingual-r2-fp32-v1 1"],
        },
        MISSING_ASSETS,
      ),
    );

    expect(statusOf(report, "selection_assets")).toBe("not_ready");
  });

  it("reports the migration tail when the assets are present", () => {
    const report = judgeLanes(
      observation(
        {
          status: "composed",
          documentMode: "remote",
          cardMode: "remote",
          requiresLocalAssets: true,
          restoredProfiles: ["document-older-v1 1"],
        },
        { status: "installed", directory: "/assets/rev_a" },
      ),
    );

    const assets = report.lanes.find(
      (verdict) => verdict.lane === "selection_assets",
    );
    expect(assets?.detail).toContain("document-older-v1 1");
  });

  it("is not ready when the bindings could not be assembled at all", () => {
    // Not knowing which bindings are required is not the same as knowing none
    // are, so an unassembled composition blocks even with assets installed.
    const report = judgeLanes(
      observation(
        {
          status: "unavailable",
          detail: "document embedding remote binding is invalid: credential_missing",
        },
        { status: "installed", directory: "/assets/rev_a" },
      ),
    );

    expect(statusOf(report, "selection_assets")).toBe("not_ready");
    expect(statusOf(report, "resolve")).toBe("not_ready");
    expect(report.serviceable).toBe(false);
  });
});
