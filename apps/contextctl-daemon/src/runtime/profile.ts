/**
 * The versioned operating limits a daemon runs under.
 *
 * Every number here is a design value, and the version is what makes them
 * changeable without becoming settings. The design states the rule directly:
 * an operator may adjust these, but only by recording the profile version, the
 * applied value and the resulting measurement together — so a deployment that
 * moved a limit can be told apart from one that never had it, and a benchmark
 * can say which profile it was measured under.
 *
 * That is why this is one frozen object rather than a handful of environment
 * variables. Scattered variables have no version, cannot be validated against
 * each other, and make "which limits was this process actually running" a
 * question nobody can answer after the fact.
 */

export const DAEMON_RUNTIME_PROFILE_VERSION = "daemon-runtime-profile-v1";

/**
 * One execution lane's bounded capacity.
 *
 * `queueDepth` is a ceiling on waiting work, not a target. The design forbids
 * unbounded in-memory queues, and the reason is that an unbounded queue does not
 * remove backpressure — it moves it into memory, where the failure is an OOM
 * instead of a refusal the caller can act on.
 */
export interface LaneCapacity {
  /** How many admitted tasks may run at once. At least one. */
  readonly concurrency: number;
  /** How many may wait. Zero means "run or refuse", never "wait forever". */
  readonly queueDepth: number;
}

/**
 * The four operating areas and Ingestion's provider sub-boundary, sized
 * independently.
 *
 * Independent rather than drawn from a shared pool, and that independence is
 * what implements the design's reservation rule: Resolve capacity is not a
 * priority that background work outranks, it is capacity background work has no
 * handle on. A shared pool with priorities would still let a burst of Ingestion
 * batches occupy every slot for as long as they run.
 */
export interface DaemonLaneProfile {
  /** Query resolution. The only lane a caller can reach directly. */
  readonly resolve: LaneCapacity;
  /** Registry claiming one Publication out of Ingestion's outbox. */
  readonly registryConsume: LaneCapacity;
  /** Rebuilding the approved-Card candidate index. */
  readonly selectionAssets: LaneCapacity;
  /** Source observation, capture and index publication. */
  readonly ingestion: LaneCapacity;
  /** Embedding provider batches inside an admitted Ingestion Source job. */
  readonly ingestionEmbedding: LaneCapacity;
}

/**
 * The request time budget, in milliseconds from transport arrival.
 *
 * Four numbers with one invariant between them: the stages have to fit inside
 * the total with the assembly reserve still untouched. A budget that fails that
 * check does not degrade gracefully — it produces a request that spends its
 * whole allowance searching and then has no time to serialize what it found,
 * which is the one outcome worse than a timeout, because the work was done and
 * thrown away.
 */
export interface DaemonDeadlineProfile {
  /** Whole request, measured from arrival rather than from admission. */
  readonly totalMs: number;
  /** Selection and planning, before any index is touched. */
  readonly selectionMs: number;
  /** Held back so a finished answer can always be assembled and serialized. */
  readonly assemblyReserveMs: number;
  /** Upper bound on managed search regardless of how much total time is left. */
  readonly managedSearchCeilingMs: number;
}

export interface DaemonRuntimeProfile {
  readonly version: string;
  readonly lanes: DaemonLaneProfile;
  readonly deadlines: DaemonDeadlineProfile;
}

/** Ingestion provider batches admitted at once. */
export const INGESTION_EMBEDDING_BATCH_LIMIT = 2;

/**
 * The design's own values.
 *
 * Frozen so a caller that receives the profile cannot quietly retune the
 * process it was handed by. Adjustment goes through `defineDaemonRuntimeProfile`
 * with a new version, which validates the result.
 */
export const DAEMON_RUNTIME_PROFILE_V1: DaemonRuntimeProfile = Object.freeze({
  version: DAEMON_RUNTIME_PROFILE_VERSION,
  lanes: Object.freeze({
    resolve: Object.freeze({ concurrency: 8, queueDepth: 32 }),
    registryConsume: Object.freeze({ concurrency: 1, queueDepth: 8 }),
    // One catalog snapshot and one embedding batch, which the design states as
    // two separate limits over the same lane. A rebuild embeds inside the
    // snapshot it was started for, so one running rebuild is one of each and a
    // single concurrency of one expresses both.
    selectionAssets: Object.freeze({ concurrency: 1, queueDepth: 1 }),
    // One Source job. Provider batches inside it use the separate sub-boundary
    // below, because the two limits bound different units of work.
    ingestion: Object.freeze({ concurrency: 1, queueDepth: 4 }),
    // A provider call is already one bounded batch. There is deliberately no
    // second Ingestion-owned wait queue here: the pipeline owns its batch
    // sequence and retries a retriable refusal. When the physical local session
    // is shared, the separate `embedding-runtime-scheduler-v1` owns the bounded
    // cross-domain priority queue after this admission boundary.
    ingestionEmbedding: Object.freeze({
      concurrency: INGESTION_EMBEDDING_BATCH_LIMIT,
      queueDepth: 0,
    }),
  }),
  deadlines: Object.freeze({
    totalMs: 3_000,
    selectionMs: 750,
    assemblyReserveMs: 500,
    managedSearchCeilingMs: 1_750,
  }),
});

/**
 * The background embedding batch ceiling the design names separately.
 *
 * Stated here so the value has one home. The daemon applies it to Ingestion's
 * provider boundary; the shared-session priority scheduler is a separate
 * operating concern with its own versioned profile.
 */
export type DaemonRuntimeProfileProblem =
  | "version_missing"
  | "concurrency_invalid"
  | "queue_depth_invalid"
  | "deadline_invalid"
  | "stages_exceed_total"
  | "search_ceiling_exceeds_budget";

/**
 * A profile that would not hold together.
 *
 * Refused at definition rather than clamped, because every clamp here is a
 * silent decision about someone's operating budget. An operator who asked for a
 * selection stage longer than the whole request has stated something they did
 * not mean, and the useful answer names which rule they crossed.
 */
export class DaemonRuntimeProfileError extends Error {
  constructor(
    readonly problem: DaemonRuntimeProfileProblem,
    readonly field: string,
  ) {
    super(`daemon runtime profile is invalid: ${problem} (${field})`);
    this.name = "DaemonRuntimeProfileError";
  }
}

export interface DaemonRuntimeProfileOverrides {
  readonly version: string;
  readonly lanes?: Partial<DaemonLaneProfile>;
  readonly deadlines?: Partial<DaemonDeadlineProfile>;
}

/**
 * Builds an adjusted profile, validated as a whole.
 *
 * The version is required rather than defaulted. An adjusted profile that kept
 * `daemon-runtime-profile-v1` as its name would make the recorded version stop
 * identifying the values, and every measurement taken under it would be filed
 * against limits it did not run with.
 */
export function defineDaemonRuntimeProfile(
  overrides: DaemonRuntimeProfileOverrides,
): DaemonRuntimeProfile {
  if (overrides.version.trim() === "") {
    throw new DaemonRuntimeProfileError("version_missing", "version");
  }
  const profile: DaemonRuntimeProfile = {
    version: overrides.version,
    lanes: {
      resolve: overrides.lanes?.resolve ?? DAEMON_RUNTIME_PROFILE_V1.lanes.resolve,
      registryConsume:
        overrides.lanes?.registryConsume ??
        DAEMON_RUNTIME_PROFILE_V1.lanes.registryConsume,
      selectionAssets:
        overrides.lanes?.selectionAssets ??
        DAEMON_RUNTIME_PROFILE_V1.lanes.selectionAssets,
      ingestion:
        overrides.lanes?.ingestion ?? DAEMON_RUNTIME_PROFILE_V1.lanes.ingestion,
      ingestionEmbedding:
        overrides.lanes?.ingestionEmbedding ??
        DAEMON_RUNTIME_PROFILE_V1.lanes.ingestionEmbedding,
    },
    deadlines: {
      ...DAEMON_RUNTIME_PROFILE_V1.deadlines,
      ...overrides.deadlines,
    },
  };
  assertDaemonRuntimeProfile(profile);
  return Object.freeze({
    version: profile.version,
    lanes: Object.freeze({
      resolve: Object.freeze({ ...profile.lanes.resolve }),
      registryConsume: Object.freeze({ ...profile.lanes.registryConsume }),
      selectionAssets: Object.freeze({ ...profile.lanes.selectionAssets }),
      ingestion: Object.freeze({ ...profile.lanes.ingestion }),
      ingestionEmbedding: Object.freeze({
        ...profile.lanes.ingestionEmbedding,
      }),
    }),
    deadlines: Object.freeze({ ...profile.deadlines }),
  });
}

/**
 * Checks every rule the profile values have to satisfy together.
 *
 * Exported so a composition can validate a profile it received rather than
 * built, and total over the profile: nothing here reports the first problem and
 * stops on a field it has not checked.
 */
export function assertDaemonRuntimeProfile(
  profile: DaemonRuntimeProfile,
): void {
  if (profile.version.trim() === "") {
    throw new DaemonRuntimeProfileError("version_missing", "version");
  }

  const lanes: readonly (readonly [string, LaneCapacity])[] = [
    ["resolve", profile.lanes.resolve],
    ["registryConsume", profile.lanes.registryConsume],
    ["selectionAssets", profile.lanes.selectionAssets],
    ["ingestion", profile.lanes.ingestion],
    ["ingestionEmbedding", profile.lanes.ingestionEmbedding],
  ];
  for (const [name, lane] of lanes) {
    if (!Number.isSafeInteger(lane.concurrency) || lane.concurrency < 1) {
      throw new DaemonRuntimeProfileError(
        "concurrency_invalid",
        `lanes.${name}.concurrency`,
      );
    }
    if (!Number.isSafeInteger(lane.queueDepth) || lane.queueDepth < 0) {
      throw new DaemonRuntimeProfileError(
        "queue_depth_invalid",
        `lanes.${name}.queueDepth`,
      );
    }
  }

  const { totalMs, selectionMs, assemblyReserveMs, managedSearchCeilingMs } =
    profile.deadlines;
  const durations: readonly (readonly [string, number])[] = [
    ["totalMs", totalMs],
    ["selectionMs", selectionMs],
    ["assemblyReserveMs", assemblyReserveMs],
    ["managedSearchCeilingMs", managedSearchCeilingMs],
  ];
  for (const [name, value] of durations) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DaemonRuntimeProfileError(
        "deadline_invalid",
        `deadlines.${name}`,
      );
    }
  }

  // Selection and the assembly reserve both come out of the total, and they do
  // not overlap: assembly runs after selection, never beside it. A profile where
  // they alone fill the total leaves nothing for the search between them.
  if (selectionMs + assemblyReserveMs >= totalMs) {
    throw new DaemonRuntimeProfileError(
      "stages_exceed_total",
      "deadlines.selectionMs + deadlines.assemblyReserveMs",
    );
  }

  // The ceiling is an upper bound, so it only has to be reachable — a ceiling
  // no request could ever spend is a number that means nothing.
  if (managedSearchCeilingMs > totalMs - assemblyReserveMs) {
    throw new DaemonRuntimeProfileError(
      "search_ceiling_exceeds_budget",
      "deadlines.managedSearchCeilingMs",
    );
  }
}
