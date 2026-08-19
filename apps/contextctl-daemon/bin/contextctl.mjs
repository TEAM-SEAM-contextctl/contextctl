#!/usr/bin/env node
/**
 * The installed command, and the only part of it that is checked in.
 *
 * npm links a workspace `bin` at install time and silently skips one whose
 * target file does not exist. Pointing `bin` straight at `dist/cli/main.js`
 * therefore worked on a machine that had already built and produced no link at
 * all in CI, where the order is `npm ci`, then `npm run build` — the build
 * cannot come first, because it needs the install. A committed launcher is
 * present before any of that, so the link is always created.
 *
 * It stays a `.mjs` rather than another TypeScript file for the same reason: a
 * compiled launcher would be absent at install time exactly like the entry point
 * it replaced.
 *
 * Nothing is implemented here. Importing the entry point runs it — the module
 * dispatches at top level and sets `process.exitCode` itself — so this file's
 * whole job is to name it, and to say something useful when it is missing.
 */
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const entryPoint = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/cli/main.js",
);

try {
  await import(pathToFileURL(entryPoint).href);
} catch (error) {
  // A missing build is the one failure this wrapper can diagnose better than
  // the loader can: `ERR_MODULE_NOT_FOUND` names a path inside `dist` and reads
  // as a broken install rather than as a step the operator has not run yet.
  if (error?.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("dist")) {
    process.stderr.write(
      "contextctl is not built yet. Run `npm run build` in the repository root.\n",
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
