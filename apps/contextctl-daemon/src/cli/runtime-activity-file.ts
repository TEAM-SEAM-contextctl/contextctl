import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { DaemonStateIdentity } from "../runtime/state-identity.js";
import type { RuntimeActivity } from "./status.js";

const ACTIVITY_SCHEMA_VERSION = 1;
const MAX_ACTIVITY_FILE_BYTES = 64 * 1024;
const MAX_ACTIVITY_INSTANCES = 128;
const MAX_ACTIVITY_FILES_SCANNED = 1_024;
const DEFAULT_PUBLISH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_AGE_MS = 4_000;
const ACTIVITY_LANES = [
  "resolve",
  "registry_consume",
  "selection_assets",
  "ingestion",
] as const;
const ACTIVITY_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

interface RuntimeActivityDocument {
  readonly schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly stateIdentityDigest: string;
  readonly observedAt: number;
  readonly activity: RuntimeActivity;
}

export interface RuntimeActivityPublisher {
  start(readActivity: () => RuntimeActivity): Promise<void>;
  close(): Promise<void>;
}

/**
 * Publishes counts-only live activity for the local operator CLI.
 *
 * Each serve process owns one file. Concurrent daemons sharing a
 * CONTEXTCTL_HOME therefore remain visible without either process replacing or
 * deleting the other's snapshot. The directory is an implementation-private
 * bridge, not a second daemon API.
 */
export function createRuntimeActivityPublisher(input: {
  readonly directory: string;
  readonly stateIdentity: DaemonStateIdentity;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): RuntimeActivityPublisher {
  const instanceId = randomUUID();
  const file = join(input.directory, `${instanceId}.json`);
  const intervalMs = input.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  const now = input.now ?? Date.now;
  const onError = input.onError ?? (() => undefined);
  let readActivity: (() => RuntimeActivity) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  let writeFailureReported = false;

  const publish = async (): Promise<void> => {
    const read = readActivity;
    if (read === undefined) return;
    await writeActivityDocument(input.directory, file, {
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      instanceId,
      stateIdentityDigest: digestStateIdentity(input.stateIdentity),
      observedAt: now(),
      activity: projectRuntimeActivity(read()),
    });
  };

  const enqueue = (): void => {
    pending = pending
      .then(publish)
      .then(() => {
        writeFailureReported = false;
      })
      .catch((error: unknown) => {
        if (!writeFailureReported) onError(error);
        writeFailureReported = true;
      });
  };

  return {
    async start(read): Promise<void> {
      if (readActivity !== undefined) {
        throw new Error("runtime activity publisher already started");
      }
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
        throw new TypeError("runtime activity publish interval must be at least 100ms");
      }
      readActivity = read;
      try {
        await publish();
      } catch (error) {
        readActivity = undefined;
        throw error;
      }
      timer = setInterval(enqueue, intervalMs);
      timer.unref();
    },

    async close(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      readActivity = undefined;
      await pending;
      await unlink(file).catch((error: unknown) => {
        if (!isMissingPath(error)) throw error;
      });
    },
  };
}

/** Reads and aggregates fresh, strictly validated per-process snapshots. */
export async function readRuntimeActivity(input: {
  readonly directory: string;
  readonly stateIdentity: DaemonStateIdentity;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}): Promise<RuntimeActivity | undefined> {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = input.now ?? Date.now;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) return undefined;

  try {
    const directoryMetadata = await lstat(input.directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      return undefined;
    }
    const entries = (await readdir(input.directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && ACTIVITY_FILE_PATTERN.test(entry.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    // A private directory can still accumulate files after SIGKILL. Bound the
    // work without letting stale snapshots hide a smaller set of live daemons.
    // Taking an arbitrary subset beyond this bound would under-report load, so
    // fail closed instead.
    if (entries.length > MAX_ACTIVITY_FILES_SCANNED) return undefined;

    const identityDigest = digestStateIdentity(input.stateIdentity);
    const observedNow = now();
    const activities: RuntimeActivity[] = [];
    for (const entry of entries) {
      const document = await readActivityDocument(
        join(input.directory, entry.name),
      );
      if (document === undefined) continue;
      if (document.stateIdentityDigest !== identityDigest) continue;
      const age = observedNow - document.observedAt;
      if (age < -maxAgeMs || age > maxAgeMs) continue;
      activities.push(document.activity);
      if (activities.length > MAX_ACTIVITY_INSTANCES) return undefined;
    }
    return aggregateRuntimeActivities(activities);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    return undefined;
  }
}

async function readActivityDocument(
  file: string,
): Promise<RuntimeActivityDocument | undefined> {
  try {
    const metadata = await lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_ACTIVITY_FILE_BYTES
    ) {
      return undefined;
    }
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRuntimeActivityDocument(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeActivityDocument(
  directory: string,
  file: string,
  document: RuntimeActivityDocument,
): Promise<void> {
  await prepareActivityDirectory(directory);
  const temporary = join(
    directory,
    `.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  // Serialize before creating a file. An invalid runtime value cannot leave a
  // temporary artifact behind.
  const serialized = `${JSON.stringify(document)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function prepareActivityDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("runtime activity path must be a real directory");
  }
  await chmod(directory, 0o700);
}

/** Copies only the fixed count/state schema; all caller-added fields vanish. */
function projectRuntimeActivity(value: RuntimeActivity): RuntimeActivity {
  if (!isRecord(value) || !Array.isArray(value["depths"])) {
    throw new TypeError("runtime activity must be an object with lane depths");
  }
  const rawDepths = value["depths"];
  const embedding = value["embedding"];
  if (!isRecord(embedding)) {
    throw new TypeError("runtime embedding activity must be an object");
  }
  const projected: RuntimeActivity = {
    lifecycle: value["lifecycle"] as RuntimeActivity["lifecycle"],
    profileVersion: value["profileVersion"] as string,
    depths: ACTIVITY_LANES.map((lane) => {
      const depth = rawDepths.find(
        (candidate) => isRecord(candidate) && candidate["lane"] === lane,
      );
      return {
        lane,
        active: isRecord(depth) ? (depth["active"] as number) : -1,
        concurrency: isRecord(depth) ? (depth["concurrency"] as number) : -1,
        queued: isRecord(depth) ? (depth["queued"] as number) : -1,
        queueDepth: isRecord(depth) ? (depth["queueDepth"] as number) : -1,
      };
    }),
    embedding: {
      profileVersion: embedding["profileVersion"] as string,
      accepting: embedding["accepting"] as boolean,
      active: embedding["active"] as number,
      resolveStarts: embedding["resolveStarts"] as number,
      backgroundStarts: embedding["backgroundStarts"] as number,
      resolveReservations: embedding["resolveReservations"] as number,
      resolveQueued: embedding["resolveQueued"] as number,
      backgroundQueued: embedding["backgroundQueued"] as number,
      eventLoopLagMs: embedding["eventLoopLagMs"] as number,
      eventLoopState: embedding["eventLoopState"] as "normal" | "delayed",
      rssBytes: embedding["rssBytes"] as number,
      rssLimitBytes: embedding["rssLimitBytes"] as number,
      memoryState: embedding["memoryState"] as "normal" | "limited",
      backgroundStartsSuppressed:
        embedding["backgroundStartsSuppressed"] as boolean,
    },
  };
  if (!isRuntimeActivity(projected)) {
    throw new TypeError("runtime activity contains an invalid count or state");
  }
  return projected;
}

function aggregateRuntimeActivities(
  activities: readonly RuntimeActivity[],
): RuntimeActivity | undefined {
  if (activities.length === 0) return undefined;
  const sum = (select: (activity: RuntimeActivity) => number): number =>
    activities.reduce((total, activity) => total + select(activity), 0);
  const laneDepth = (activity: RuntimeActivity, lane: string) =>
    activity.depths.find((depth) => depth.lane === lane);
  const summed = (
    lane: (typeof ACTIVITY_LANES)[number],
    field: "active" | "concurrency" | "queued" | "queueDepth",
  ) => sum((activity) => laneDepth(activity, lane)?.[field] ?? 0);
  const result: RuntimeActivity = {
    lifecycle: activities.some((activity) => activity.lifecycle === "accepting")
      ? "accepting"
      : activities.some((activity) => activity.lifecycle === "draining")
        ? "draining"
        : "closed",
    profileVersion: commonValue(
      activities.map((activity) => activity.profileVersion),
    ),
    depths: ACTIVITY_LANES.map((lane) => ({
      lane,
      active: summed(lane, "active"),
      concurrency: summed(lane, "concurrency"),
      queued: summed(lane, "queued"),
      queueDepth: summed(lane, "queueDepth"),
    })),
    embedding: {
      profileVersion: commonValue(
        activities.map((activity) => activity.embedding.profileVersion),
      ),
      accepting: activities.some((activity) => activity.embedding.accepting),
      active: sum((activity) => activity.embedding.active),
      resolveStarts: sum((activity) => activity.embedding.resolveStarts),
      backgroundStarts: sum(
        (activity) => activity.embedding.backgroundStarts,
      ),
      resolveReservations: sum(
        (activity) => activity.embedding.resolveReservations,
      ),
      resolveQueued: sum((activity) => activity.embedding.resolveQueued),
      backgroundQueued: sum(
        (activity) => activity.embedding.backgroundQueued,
      ),
      eventLoopLagMs: Math.max(
        ...activities.map((activity) => activity.embedding.eventLoopLagMs),
      ),
      eventLoopState: activities.some(
        (activity) => activity.embedding.eventLoopState === "delayed",
      )
        ? "delayed"
        : "normal",
      rssBytes: sum((activity) => activity.embedding.rssBytes),
      rssLimitBytes: sum((activity) => activity.embedding.rssLimitBytes),
      memoryState: activities.some(
        (activity) => activity.embedding.memoryState === "limited",
      )
        ? "limited"
        : "normal",
      backgroundStartsSuppressed: activities.some(
        (activity) => activity.embedding.backgroundStartsSuppressed,
      ),
    },
  };
  return isRuntimeActivity(result) ? result : undefined;
}

function commonValue(values: readonly string[]): string {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first)
    ? first
    : "mixed";
}

function isRuntimeActivityDocument(
  value: unknown,
): value is RuntimeActivityDocument {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "instanceId",
      "stateIdentityDigest",
      "observedAt",
      "activity",
    ])
  ) {
    return false;
  }
  return (
    value["schemaVersion"] === ACTIVITY_SCHEMA_VERSION &&
    isNonEmptyString(value["instanceId"]) &&
    isNonEmptyString(value["stateIdentityDigest"]) &&
    isFiniteNumber(value["observedAt"]) &&
    isRuntimeActivity(value["activity"])
  );
}

function isRuntimeActivity(value: unknown): value is RuntimeActivity {
  if (
    !hasExactKeys(value, [
      "lifecycle",
      "profileVersion",
      "depths",
      "embedding",
    ]) ||
    !Array.isArray(value["depths"])
  ) {
    return false;
  }
  const lanes = value["depths"].map((depth) =>
    isRecord(depth) ? depth["lane"] : undefined,
  );
  return (
    (value["lifecycle"] === "accepting" ||
      value["lifecycle"] === "draining" ||
      value["lifecycle"] === "closed") &&
    isNonEmptyString(value["profileVersion"]) &&
    value["depths"].length === ACTIVITY_LANES.length &&
    value["depths"].every(isLaneDepth) &&
    ACTIVITY_LANES.every(
      (lane) => lanes.filter((candidate) => candidate === lane).length === 1,
    ) &&
    isEmbeddingSnapshot(value["embedding"])
  );
}

function isLaneDepth(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "lane",
      "active",
      "concurrency",
      "queued",
      "queueDepth",
    ])
  ) {
    return false;
  }
  return (
    ACTIVITY_LANES.some((lane) => value["lane"] === lane) &&
    isNonNegativeInteger(value["active"]) &&
    isNonNegativeInteger(value["concurrency"]) &&
    isNonNegativeInteger(value["queued"]) &&
    isNonNegativeInteger(value["queueDepth"])
  );
}

function isEmbeddingSnapshot(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "profileVersion",
      "accepting",
      "active",
      "resolveStarts",
      "backgroundStarts",
      "resolveReservations",
      "resolveQueued",
      "backgroundQueued",
      "eventLoopLagMs",
      "eventLoopState",
      "rssBytes",
      "rssLimitBytes",
      "memoryState",
      "backgroundStartsSuppressed",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value["profileVersion"]) &&
    typeof value["accepting"] === "boolean" &&
    isNonNegativeInteger(value["active"]) &&
    isNonNegativeInteger(value["resolveStarts"]) &&
    isNonNegativeInteger(value["backgroundStarts"]) &&
    isNonNegativeInteger(value["resolveReservations"]) &&
    isNonNegativeInteger(value["resolveQueued"]) &&
    isNonNegativeInteger(value["backgroundQueued"]) &&
    isNonNegativeNumber(value["eventLoopLagMs"]) &&
    (value["eventLoopState"] === "normal" ||
      value["eventLoopState"] === "delayed") &&
    isNonNegativeNumber(value["rssBytes"]) &&
    isNonNegativeNumber(value["rssLimitBytes"]) &&
    (value["memoryState"] === "normal" || value["memoryState"] === "limited") &&
    typeof value["backgroundStartsSuppressed"] === "boolean"
  );
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function digestStateIdentity(identity: DaemonStateIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.stateNamespaceId, identity.securityDomain]))
    .digest("hex");
}
