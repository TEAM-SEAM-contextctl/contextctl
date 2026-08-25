import { copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_DEMO_DOCUMENTS = Object.freeze([
  "expense.md",
  "leave.md",
  "payment.md",
  "refund.md",
  "shipping.md",
] as const);

export class DemoInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoInitializationError";
  }
}

/**
 * Copies the immutable package examples into a directory the operator owns.
 *
 * A Source must not point into a global npm installation: changing Node
 * versions, upgrading contextctl, or uninstalling the package can move or
 * remove that tree. The command therefore exports the examples instead of
 * returning their package-private location. It stages all files beside the
 * destination and renames once so an interrupted copy never leaves a partial
 * demo that later looks complete.
 */
export async function initializeBundledDemo(input: {
  readonly destination: string;
  readonly workingDirectory: string;
}): Promise<{ readonly directory: string; readonly documents: readonly string[] }> {
  const destination = resolve(input.workingDirectory, input.destination);
  if (await pathExists(destination)) {
    throw new DemoInitializationError(
      `데모 디렉터리가 이미 존재한다: ${destination}\n다른 빈 경로를 지정하거나 기존 디렉터리를 직접 확인하십시오.`,
    );
  }

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(destination) || "contextctl-demo"}.tmp-`));
  const bundled = fileURLToPath(new URL("../../demo/docs/", import.meta.url));

  try {
    await Promise.all(
      BUNDLED_DEMO_DOCUMENTS.map(async (name) => {
        await copyFile(join(bundled, name), join(staging, name));
      }),
    );
    await rename(staging, destination);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    if (isAlreadyExists(error)) {
      throw new DemoInitializationError(
        `데모 디렉터리가 이미 존재한다: ${destination}\n다른 빈 경로를 지정하거나 기존 디렉터리를 직접 확인하십시오.`,
      );
    }
    throw error;
  }

  return {
    directory: destination,
    documents: BUNDLED_DEMO_DOCUMENTS,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
