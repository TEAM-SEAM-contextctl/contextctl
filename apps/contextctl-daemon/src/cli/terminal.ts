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
  readonly stdoutColumns?: number;
  readonly stderrColumns?: number;
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
      const wrapped = wrapForTerminal(
        text,
        input.stdoutIsTTY ? input.stdoutColumns : undefined,
      );
      input.writeStdout(
        `${input.stdoutIsTTY && ansiEnabled ? decorateStdout(wrapped) : wrapped}\n`,
      );
    },
    stderr: (text) => {
      completeProgress();
      const wrapped = wrapForTerminal(
        text,
        input.stderrIsTTY ? input.stderrColumns : undefined,
      );
      input.writeStderr(
        `${input.stderrIsTTY && ansiEnabled ? decorateStderr(wrapped) : wrapped}\n`,
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

/** Wraps human-facing TTY prose while preserving machine-readable JSON. */
function wrapForTerminal(text: string, columns: number | undefined): string {
  if (
    columns === undefined ||
    !Number.isInteger(columns) ||
    columns < 20 ||
    isJsonDocument(text)
  ) {
    return text;
  }
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, columns))
    .join("\n");
}

function wrapLine(text: string, columns: number): readonly string[] {
  if (displayWidth(text) <= columns || text.trim() === "") {
    return [text];
  }
  const indentation = text.match(/^\s*/u)?.[0] ?? "";
  const continuation = `${indentation}  `;
  const words = text.trimStart().split(/\s+/u);
  const lines: string[] = [];
  let current = indentation;

  for (const word of words) {
    const candidate = current.trim() === "" ? `${current}${word}` : `${current} ${word}`;
    if (displayWidth(candidate) <= columns || current.trim() === "") {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = `${continuation}${word}`;
  }
  lines.push(current);
  return lines;
}

/** Terminal columns, not UTF-16 code units: Hangul and CJK glyphs are wide. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (/\p{Mark}/u.test(character)) {
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function isJsonDocument(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
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
