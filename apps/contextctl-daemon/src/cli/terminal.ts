/** ANSI control sequences are confined to the interactive terminal adapter. */
const ANSI = {
  clearLine: "\u001b[2K",
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
} as const;

const HEADING_PATTERN =
  /^(질의:|선택 모드:|스코어링:|페이로드 스키마 버전:|예산:|판정 집계:|선택된 Card(?:\s|:)|컨텍스트 항목(?:\s|:)|runtime\s)/u;

export interface CliTerminal {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly progress: (text: string) => void;
  /** Completes an in-place progress line before the process exits. */
  readonly finish: () => void;
}

/**
 * Owns only stream presentation. Renderers keep producing plain text and
 * `runCli` keeps deciding which stream a value belongs to.
 *
 * Redirected output is deliberately byte-stable: one trailing newline per
 * write and no control sequences. Interactive stderr may reuse its current
 * line for progress, while ordinary diagnostics always start on a clean line.
 */
export function createCliTerminal(input: {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly environment: Readonly<Partial<Record<string, string>>>;
}): CliTerminal {
  const ansiEnabled =
    input.environment.NO_COLOR === undefined &&
    input.environment.TERM !== "dumb";
  let progressActive = false;

  const completeProgress = (): void => {
    if (!progressActive) return;
    input.writeStderr("\n");
    progressActive = false;
  };

  return {
    stdout: (text) => {
      input.writeStdout(
        `${input.stdoutIsTTY && ansiEnabled ? decorateStdout(text) : text}\n`,
      );
    },
    stderr: (text) => {
      completeProgress();
      input.writeStderr(
        `${input.stderrIsTTY && ansiEnabled ? decorateStderr(text) : text}\n`,
      );
    },
    progress: (text) => {
      if (!input.stderrIsTTY || !ansiEnabled) {
        input.writeStderr(`${text}\n`);
        return;
      }
      const rendered = colour(text, ANSI.cyan);
      input.writeStderr(`\r${ANSI.clearLine}${rendered}`);
      progressActive = true;
    },
    finish: completeProgress,
  };
}

function decorateStdout(text: string): string {
  return text
    .split("\n")
    .map((line) => decorateStatusLine(decorateHeading(line)))
    .join("\n");
}

function decorateStderr(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/오류|실패|거부|not_ready/u.test(line)) {
        return colour(line, ANSI.red);
      }
      if (/경고|degraded/u.test(line)) {
        return colour(line, ANSI.yellow);
      }
      return line;
    })
    .join("\n");
}

function decorateStatusLine(line: string): string {
  return line.replace(
    /^(resolve|registry|selection_assets|ingestion)(\s+)(ready|degraded|not_ready)(\s+)/u,
    (_match, lane: string, firstGap: string, status: string, secondGap: string) => {
      const colourCode =
        status === "ready"
          ? ANSI.green
          : status === "degraded"
            ? ANSI.yellow
            : ANSI.red;
      return `${lane}${firstGap}${colour(status, colourCode)}${secondGap}`;
    },
  );
}

function decorateHeading(line: string): string {
  if (HEADING_PATTERN.test(line)) {
    return colour(line, ANSI.bold);
  }
  return line;
}

function colour(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}
