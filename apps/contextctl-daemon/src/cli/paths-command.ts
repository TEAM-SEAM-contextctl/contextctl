import type { CommandOutcome } from "./commands.js";
import { buildPathsReport, renderPathsReport } from "./paths-report.js";

/** Lightweight path report that does not load the assembled daemon runtime. */
export async function runPaths(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
}): Promise<CommandOutcome> {
  const report = await buildPathsReport({
    environment: input.environment,
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
  });
  return { stdout: renderPathsReport(report), stderr: [], exitCode: 0 };
}
