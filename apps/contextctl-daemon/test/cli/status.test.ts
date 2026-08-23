import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../src/cli/exit-codes.js";
import {
  formatDuration,
  judgeLanes,
  renderStatusReport,
  type LaneName,
  type LaneStatus,
  type StatusObservation,
} from "../../src/cli/status.js";

/**
 * The rules a status surface exists to encode, asserted without a database.
 *
 * The judgement is pure precisely so these combinations are reachable: Registry
 * two hours behind while resolve still answers, assets never installed, a store
 * that cannot be read at all. Reproducing them through real SQLite and the 415MB
 * embedding artifact would mean the interesting half never gets a test — and the
 * interesting half is where a one-boolean health check goes wrong.
 */

function healthy(overrides: Partial<StatusObservation> = {}): StatusObservation {
  return {
    assets: { status: "installed", directory: "/home/.contextctl/assets/rev_a" },
    vectorIndex: {
      status: "configured",
      endpoint: "http://localhost:6333/",
    },
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
    // The historical default: one local model serving both layers. Every
    // pre-existing case in this file was written against that deployment, so it
    // stays the baseline and the remote combinations are stated explicitly.
    embedding: {
      status: "composed",
      documentMode: "local",
      cardMode: "local",
      requiresLocalAssets: true,
      restoredProfiles: [],
    },
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof judgeLanes>, lane: LaneName): LaneStatus {
  const verdict = report.lanes.find((each) => each.lane === lane);
  if (verdict === undefined) {
    throw new Error(`lane not reported: ${lane}`);
  }
  return verdict.status;
}

describe("judgeLanes", () => {
  it("reports all four lanes, in the order the design lists them", () => {
    const report = judgeLanes(healthy());

    expect(report.lanes.map((verdict) => verdict.lane)).toEqual([
      "resolve",
      "registry",
      "selection_assets",
      "ingestion",
    ]);
    expect(report.lanes.every((verdict) => verdict.status === "ready")).toBe(true);
    expect(report.serviceable).toBe(true);
  });

  it("keeps resolve ready while Registry is behind", () => {
    // 설계안 120절. This is the assertion the whole command exists for: answering
    // from a Card that is two hours old is the system working, not failing, and a
    // single boolean would have reported the service as down.
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: ["src_payments"],
          worstFreshnessLagMs: 2 * 60 * 60 * 1_000,
          stalePendingScopeCount: 0,
          approvedCardCount: 3,
        },
      }),
    );

    expect(statusOf(report, "registry")).toBe("degraded");
    expect(statusOf(report, "resolve")).toBe("ready");
    // And a delay is not a reason to stop serving.
    expect(report.serviceable).toBe(true);
  });

  it("names the behind Source and how stale it is", () => {
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: ["src_payments", "src_docs"],
          worstFreshnessLagMs: 3 * 60 * 60 * 1_000,
          stalePendingScopeCount: 0,
          approvedCardCount: 1,
        },
      }),
    );
    const detail = report.lanes.find((each) => each.lane === "registry")?.detail ?? "";

    // "registry: degraded" alone tells an operator to go looking. The Source and
    // the age are what they would have gone looking for.
    expect(detail).toContain("src_payments");
    expect(detail).toContain("3시간");
  });

  it("degrades Registry on a Scope that has waited past the standard", () => {
    // The second of the two derived signals, and it fires on its own: a Source
    // can be caught up while a Scope from an earlier Publication is still
    // waiting. registry-reachability-v1 sets the five minutes.
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: [],
          stalePendingScopeCount: 2,
          approvedCardCount: 3,
        },
      }),
    );

    expect(statusOf(report, "registry")).toBe("degraded");
  });

  it("reports both Registry findings at once rather than the first", () => {
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: ["src_payments"],
          worstFreshnessLagMs: 90_000,
          stalePendingScopeCount: 1,
          approvedCardCount: 3,
        },
      }),
    );
    const detail = report.lanes.find((each) => each.lane === "registry")?.detail ?? "";

    expect(detail).toContain("src_payments");
    expect(detail).toContain("5분");
  });

  it("says nothing about a delay it could not measure", () => {
    // A Source that has never been consumed is behind with no lag to report.
    // Printing 0초 there would read as caught up, which is the one wrong answer.
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: ["src_payments"],
          stalePendingScopeCount: 0,
          approvedCardCount: 3,
        },
      }),
    );
    const detail = report.lanes.find((each) => each.lane === "registry")?.detail ?? "";

    expect(statusOf(report, "registry")).toBe("degraded");
    expect(detail).not.toContain("0초");
    expect(detail).not.toContain("지연");
  });

  it("cannot resolve or select without the embedding artifact", () => {
    const report = judgeLanes(
      healthy({
        assets: { status: "unavailable", detail: "설치된 리비전이 없습니다." },
      }),
    );

    // not_ready rather than degraded on both: there is no reduced service to
    // speak of, because no question can be turned into a vector at all.
    expect(statusOf(report, "selection_assets")).toBe("not_ready");
    expect(statusOf(report, "resolve")).toBe("not_ready");
    expect(report.serviceable).toBe(false);
    // The lanes that do not depend on the artifact are unaffected. Ingestion
    // embeds through the same profile, but this command reads durable state
    // rather than exercising it, so folding the two would be a guess.
    expect(statusOf(report, "registry")).toBe("ready");
  });

  it("cannot publish or resolve without a durable vector index", () => {
    const report = judgeLanes(
      healthy({
        vectorIndex: {
          status: "unavailable",
          detail: "CONTEXTCTL_QDRANT_URL이 필요합니다",
        },
      }),
    );

    expect(statusOf(report, "resolve")).toBe("not_ready");
    expect(statusOf(report, "ingestion")).toBe("not_ready");
    expect(statusOf(report, "registry")).toBe("ready");
    expect(statusOf(report, "selection_assets")).toBe("ready");
    expect(report.serviceable).toBe(false);
  });

  it("tells an operator to install rather than only that a lane is down", () => {
    const report = judgeLanes(
      healthy({ assets: { status: "unavailable", detail: "설치된 리비전이 없습니다." } }),
    );

    expect(
      report.lanes.find((each) => each.lane === "selection_assets")?.detail,
    ).toContain("contextctl install-assets");
  });

  it("cannot judge resolve when the approved catalog is unreadable", () => {
    // The design's own second condition (§120): 승인 대상을 안전하게 해석할 수 없으면
    // 준비 상태로 전환하지 않는다. A lane that does not know what is approved must
    // not answer, even though the assets are installed and the model works.
    const report = judgeLanes(
      healthy({ registry: { status: "unreadable", detail: "no such table: cards" } }),
    );

    expect(statusOf(report, "registry")).toBe("not_ready");
    expect(statusOf(report, "resolve")).toBe("not_ready");
    expect(statusOf(report, "selection_assets")).toBe("ready");
  });

  it("degrades resolve when nothing is approved yet", () => {
    // A fresh install is in this state legitimately, so it is not `not_ready`:
    // every part works and there is nothing to answer with. The action is to
    // approve a Card, and the detail says so.
    const report = judgeLanes(
      healthy({
        registry: {
          status: "read",
          behindSources: [],
          stalePendingScopeCount: 0,
          approvedCardCount: 0,
        },
      }),
    );

    expect(statusOf(report, "resolve")).toBe("degraded");
    expect(report.lanes.find((each) => each.lane === "resolve")?.detail).toContain(
      "cards approve",
    );
    expect(report.serviceable).toBe(true);
  });

  it("degrades Ingestion on a publish that never committed", () => {
    const report = judgeLanes(
      healthy({
        ingestion: {
          status: "read",
          probedSources: ["src_payments", "src_docs"],
          incompleteSources: ["src_payments"],
        },
      }),
    );

    expect(statusOf(report, "ingestion")).toBe("degraded");
    expect(report.lanes.find((each) => each.lane === "ingestion")?.detail).toContain(
      "contextctl ingest",
    );
  });

  it("states what the Ingestion probe could not see, even when it is healthy", () => {
    // The enumeration limit: only Sources with a consumer cursor can be named,
    // so a Source that was published and never consumed is outside the probe. An
    // unqualified "끝나지 않은 게시가 없습니다" would claim more than was checked.
    const report = judgeLanes(healthy());
    const detail = report.lanes.find((each) => each.lane === "ingestion")?.detail ?? "";

    expect(statusOf(report, "ingestion")).toBe("ready");
    expect(detail).toContain("소비된 Source 1개");
    expect(detail).toContain("소비된 적 없는 Source");
  });

  it("reports an unreadable Ingestion store as not_ready", () => {
    const report = judgeLanes(
      healthy({
        ingestion: { status: "unreadable", detail: "database is locked" },
      }),
    );

    expect(statusOf(report, "ingestion")).toBe("not_ready");
    expect(report.serviceable).toBe(false);
    // And it does not spread: resolve reads Registry, not Ingestion.
    expect(statusOf(report, "resolve")).toBe("ready");
  });
});

describe("the exit code a monitor reads", () => {
  it("gives not_ready a code of its own, distinct from a refused decision", () => {
    // A degraded lane exits 0 on purpose — see `runStatus`. What has to be
    // distinguishable is "a lane cannot work" from "Registry said no", because
    // the two have nothing to do with each other.
    expect(EXIT_CODES.laneNotReady).not.toBe(EXIT_CODES.ok);
    expect(EXIT_CODES.laneNotReady).not.toBe(EXIT_CODES.refused);
    expect(EXIT_CODES.laneNotReady).not.toBe(EXIT_CODES.gateFailed);
  });
});

describe("formatDuration", () => {
  it.each([
    [45_000, "45초"],
    [90_000, "1분"],
    [2 * 60 * 60 * 1_000, "2시간"],
    [50 * 60 * 60 * 1_000, "2일"],
  ])("renders %i ms as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe("renderStatusReport", () => {
  it("puts every lane on its own line with its verdict", () => {
    const lines = renderStatusReport(judgeLanes(healthy())).split("\n");

    for (const lane of ["resolve", "registry", "selection_assets", "ingestion"]) {
      expect(lines.some((line) => line.startsWith(lane))).toBe(true);
    }
  });

  it("says outright that a lane cannot serve", () => {
    const report = judgeLanes(
      healthy({ assets: { status: "unavailable", detail: "없습니다." } }),
    );

    expect(renderStatusReport(report)).toContain("서비스할 수 없습니다");
  });

  it("renders the safe in-process embedding activity snapshot", () => {
    const report = judgeLanes(healthy(), {
      lifecycle: "accepting",
      profileVersion: "daemon-runtime-profile-v1",
      depths: [
        {
          lane: "resolve",
          active: 2,
          concurrency: 8,
          queued: 3,
          queueDepth: 32,
        },
      ],
      embedding: {
        profileVersion: "embedding-runtime-scheduler-v1",
        accepting: true,
        active: 1,
        resolveReservations: 2,
        resolveQueued: 2,
        backgroundQueued: 4,
        eventLoopLagMs: 12,
        eventLoopState: "normal",
        rssBytes: 512 * 1024 * 1024,
        rssLimitBytes: 1_536 * 1024 * 1024,
        memoryState: "normal",
        backgroundStartsSuppressed: false,
      },
    });

    const output = renderStatusReport(report);
    expect(output).toContain("resolve: active 2/8, queued 3/32");
    expect(output).toContain(
      "embedding: active 1, resolve reserved 2, resolve queued 2, background queued 4",
    );
    expect(output).toContain("event loop: normal (12ms), RSS 512/1536MiB");
  });
});
