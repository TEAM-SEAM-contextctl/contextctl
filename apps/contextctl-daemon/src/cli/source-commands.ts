import { join } from "node:path";

import type { CliCommand } from "./arguments.js";
import type { CommandOutcome } from "./commands.js";
import { initializeBundledDemo } from "./demo.js";
import { renderSourceListing } from "./render.js";
import {
  addSource,
  defaultReferenceFor,
  readSourcesFile,
  removeSource,
  writeSourcesFile,
} from "./sources-file.js";

export async function runDemoInit(
  command: Extract<CliCommand, { kind: "demo_init" }>,
  workingDirectory: string,
): Promise<CommandOutcome> {
  const initialized = await initializeBundledDemo({
    destination: command.destination,
    workingDirectory,
  });
  return ok(
    [
      `데모 문서 ${initialized.documents.length}개를 준비했다: ${initialized.directory}`,
      ...initialized.documents.map((name) => `  ${name}`),
      "",
      `다음: contextctl source add ${JSON.stringify(join(initialized.directory, "leave.md"))}`,
    ].join("\n"),
  );
}

export async function runSourceAdd(
  command: Extract<CliCommand, { kind: "source_add" }>,
  sourcesFile: string,
  workingDirectory: string,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  const reference = command.reference ?? defaultReferenceFor(command.path);
  const updated = addSource(document, {
    reference,
    path: command.path,
    workingDirectory,
    ...(command.displayName === undefined
      ? {}
      : { displayName: command.displayName }),
  });
  await writeSourcesFile(sourcesFile, updated);

  const added = updated.sources[reference];
  return ok(
    [
      `Source를 등록했다: ${reference}`,
      `  경로: ${added?.path ?? command.path}`,
      "",
      "다음: contextctl ingest",
    ].join("\n"),
  );
}

export async function runSourceList(
  sourcesFile: string,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  return ok(
    renderSourceListing(
      Object.entries(document.sources).map(([reference, source]) => ({
        reference,
        path: source.path,
        displayName: source.displayName,
      })),
    ),
  );
}

export async function runSourceRemove(
  reference: string,
  sourcesFile: string,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  await writeSourcesFile(sourcesFile, removeSource(document, reference));
  return ok(`Source를 제거했다: ${reference}`);
}

function ok(stdout: string): CommandOutcome {
  return { stdout, stderr: [], exitCode: 0 };
}
