import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const LOCAL_EMBEDDING_ACTIVE_POINTER_FILE = "active.json";

/**
 * The one place that decides which directory the embedding assets are in.
 *
 * Two directories wear the same name in this codebase and mean different
 * things. `CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY` and
 * `ContextctlPaths.embeddingAssetDirectory` are the *managed root*, which holds
 * `active.json` and a `revisions/` tree. `TransformersJsLocalEmbeddingAdapter`'s
 * `artifactDirectory` is the *revision directory*, the immutable folder that
 * directly contains the manifest and the weights. Both are `string`, so nothing
 * in the type system separates them.
 *
 * They were separated by hand in two places instead, and the two disagreed:
 * `doctor` resolved the pointer and checked the revision directory, while the
 * composition handed the adapter the managed root. Every check passed and the
 * first embed failed with `embedding_artifact_unavailable`, because the adapter
 * looked for the manifest one level too high. A shared *verification function*
 * did not prevent that — both callers used the same one — so what has to be
 * shared is the *argument*, and this module is it.
 *
 * Nothing here verifies bytes. Reading the pointer is cheap and runs on every
 * CLI invocation; the 396MiB integrity check stays where it already was, in the
 * adapter's lazy load and in `doctor --deep`.
 */

/**
 * The largest `active.json` this will read, matching the installer's own bound.
 *
 * Stated here rather than imported because the constant is private to the
 * package that writes the file; duplicating the number is the lesser of the two
 * evils against reading an unbounded file into memory.
 */
const MAX_ACTIVE_POINTER_BYTES = 8 * 1024;

/** Why the managed root does not yield a usable revision directory. */
export type AssetDirectoryProblem =
  /** No `active.json`. Nothing has been installed here. */
  | { readonly kind: "not_installed"; readonly pointerPath: string; readonly reason: string }
  /** `active.json` exists but is not a pointer this build can read. */
  | { readonly kind: "pointer_unreadable"; readonly pointerPath: string }
  /** A different artifact revision is installed than this build pins. */
  | {
      readonly kind: "revision_mismatch";
      readonly installed: string;
      readonly required: string;
    }
  /** The pointer names a path outside the managed root. */
  | { readonly kind: "escapes_root"; readonly revisionDirectory: string };

export type AssetDirectoryResolution =
  | { readonly status: "resolved"; readonly directory: string }
  | { readonly status: "unavailable"; readonly problem: AssetDirectoryProblem };

/**
 * Resolves the managed root to the revision directory the adapter wants.
 *
 * `managedRoot` is whatever the operator configured, including a `--target`
 * that points somewhere else entirely: the layout inside it is what this reads,
 * never the path itself.
 */
export async function resolveActiveAssetDirectory(
  managedRoot: string,
  requiredManifestSha256: string,
): Promise<AssetDirectoryResolution> {
  const resolution = await inspectActiveAssetDirectory(managedRoot);
  if (resolution.status === "unavailable") {
    return resolution;
  }
  if (resolution.manifestSha256 !== requiredManifestSha256) {
    return {
      status: "unavailable",
      problem: {
        kind: "revision_mismatch",
        installed: resolution.manifestSha256,
        required: requiredManifestSha256,
      },
    };
  }
  return { status: "resolved", directory: resolution.directory };
}

/**
 * Reads the installer's active pointer without choosing a model revision.
 *
 * Informational commands use this form because they report what is on disk,
 * not whether that revision is valid for a runtime. Runtime and health paths
 * must call `resolveActiveAssetDirectory` with the profile digest they pin.
 * Keeping that digest at those composition points avoids loading the whole
 * Ingestion package merely to print `contextctl paths`.
 */
export async function inspectActiveAssetDirectory(
  managedRoot: string,
): Promise<
  | {
      readonly status: "resolved";
      readonly directory: string;
      readonly manifestSha256: string;
    }
  | { readonly status: "unavailable"; readonly problem: AssetDirectoryProblem }
> {
  const pointerPath = resolve(managedRoot, LOCAL_EMBEDDING_ACTIVE_POINTER_FILE);

  let raw: Buffer;
  try {
    raw = await readFile(pointerPath);
  } catch (error) {
    return {
      status: "unavailable",
      problem: {
        kind: "not_installed",
        pointerPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // The same ceiling the installer applies when it reads this file back
  // (`local-embedding-asset-installation.ts`). A pointer is three short fields;
  // anything larger is not one, and reading it into memory before finding that
  // out is work done on behalf of whatever wrote it. Refused as unreadable
  // rather than as its own outcome, because the operator's next step — reinstall
  // — is the same one a malformed pointer calls for.
  const pointer =
    raw.byteLength === 0 || raw.byteLength > MAX_ACTIVE_POINTER_BYTES
      ? undefined
      : parseActivePointer(raw.toString("utf8"));
  if (pointer === undefined) {
    return {
      status: "unavailable",
      problem: { kind: "pointer_unreadable", pointerPath },
    };
  }
  const directory = resolve(managedRoot, pointer.revisionDirectory);
  if (!isInside(managedRoot, directory)) {
    // A pointer is a file an operator can edit, so it is input rather than
    // internal state. One that escapes the root would send the adapter to read
    // weights from somewhere nobody installed them.
    return {
      status: "unavailable",
      problem: { kind: "escapes_root", revisionDirectory: pointer.revisionDirectory },
    };
  }
  return {
    status: "resolved",
    directory,
    manifestSha256: pointer.manifestSha256,
  };
}

/**
 * The pointer, or `undefined` for anything this build cannot act on.
 *
 * The only parser for this file in the daemon. Registering the shape in two
 * places would rebuild, one layer down, exactly the disagreement this module
 * exists to remove.
 */
function parseActivePointer(
  raw: string,
): { readonly manifestSha256: string; readonly revisionDirectory: string } | undefined {
  if (raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  const manifestSha256 = candidate["manifestSha256"];
  const revisionDirectory = candidate["revisionDirectory"];
  if (
    typeof manifestSha256 !== "string" ||
    typeof revisionDirectory !== "string" ||
    revisionDirectory.trim() === "" ||
    // Absolute is refused rather than resolved: the installer writes a relative
    // path, so an absolute one did not come from the installer.
    isAbsolute(revisionDirectory)
  ) {
    return undefined;
  }
  return { manifestSha256, revisionDirectory };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

/**
 * One sentence naming what is wrong and what to do, for an operator.
 *
 * Kept beside the resolution rather than at each call site so that `doctor` and
 * the composition describe the same failure the same way — the two already
 * drifted once about which directory to read.
 *
 * `not_installed` is separated from the rest on purpose. The adapter collapses
 * a missing install, a wrong digest and a short file into one
 * `embedding_artifact_unavailable`, and "you have not installed it" needs a
 * different next step from "what you installed is not what this build wants".
 */
export function describeAssetDirectoryProblem(problem: AssetDirectoryProblem): string {
  switch (problem.kind) {
    case "not_installed":
      return `임베딩 모델이 설치되어 있지 않습니다: ${problem.pointerPath} 를 읽을 수 없습니다 (${problem.reason}).`;
    case "pointer_unreadable":
      return `설치 포인터가 손상되었습니다: ${problem.pointerPath}`;
    case "revision_mismatch":
      return `설치된 개정판이 이 빌드가 요구하는 것과 다릅니다. 설치됨=${problem.installed}, 필요=${problem.required}`;
    default:
      return `설치 포인터가 자산 디렉터리 밖을 가리킵니다: ${problem.revisionDirectory}`;
  }
}
