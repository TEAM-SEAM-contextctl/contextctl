import { describe, expect, it } from "vitest";

import type {
  CliStdoutPresentation,
  StatusDisplayRow,
} from "../../src/cli/presentation.js";
import { createCliTerminal } from "../../src/cli/terminal.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/u;

function capture(options: {
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly stdoutColumns?: number;
  readonly stderrColumns?: number;
  readonly environment?: Readonly<Partial<Record<string, string>>>;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const terminal = createCliTerminal({
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    stderrIsTTY: options.stderrIsTTY ?? false,
    ...(options.stdoutColumns === undefined
      ? {}
      : { stdoutColumns: options.stdoutColumns }),
    ...(options.stderrColumns === undefined
      ? {}
      : { stderrColumns: options.stderrColumns }),
    environment: options.environment ?? {},
  });
  return { terminal, stdout, stderr };
}

describe("createCliTerminal", () => {
  it("keeps redirected output byte-stable and ANSI-free", () => {
    const { terminal, stdout, stderr } = capture();

    terminal.stdout(
      "registry  ready      정상",
      statusPresentation({
        lane: "registry",
        status: "ready",
        detail: "정상",
      }),
    );
    terminal.stderr("경고: 확인 필요");
    terminal.progress("[1/2] 모델 다운로드 50%");
    terminal.finish();

    expect(stdout.join("")).toBe("registry  ready      정상\n");
    expect(stderr.join("")).toBe(
      "경고: 확인 필요\n[1/2] 모델 다운로드 50%\n",
    );
    expect(ANSI_PATTERN.test(stdout.join("") + stderr.join(""))).toBe(false);
  });

  it("colours known status values only on an interactive stream", () => {
    const { terminal, stdout } = capture({ stdoutIsTTY: true });

    terminal.stdout("registry  ready      정상");

    expect(stdout.join("")).toContain("\u001b[32mready\u001b[0m");
  });

  it("updates TTY progress in place and completes it before diagnostics", () => {
    const { terminal, stderr } = capture({ stderrIsTTY: true });

    terminal.progress("다운로드 10%");
    terminal.progress("다운로드 20%");
    terminal.stderr("경고: 재시도");
    terminal.finish();

    const output = stderr.join("");
    expect(output.match(/\r\u001b\[2K/gu)).toHaveLength(2);
    expect(output).toContain("다운로드 20%\u001b[0m\n");
    expect(output).toContain("\u001b[33m경고: 재시도\u001b[0m\n");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("honours NO_COLOR for both colour and cursor control", () => {
    const { terminal, stdout, stderr } = capture({
      stdoutIsTTY: true,
      stderrIsTTY: true,
      environment: { NO_COLOR: "1" },
    });

    terminal.stdout("registry  ready      정상");
    terminal.progress("다운로드 10%");
    terminal.finish();

    expect(ANSI_PATTERN.test(stdout.join(""))).toBe(false);
    expect(stderr.join("")).toBe("다운로드 10%\n");
    expect(ANSI_PATTERN.test(stderr.join(""))).toBe(false);
  });

  it("keeps TERM=dumb free of terminal control sequences", () => {
    const { terminal, stderr } = capture({
      stderrIsTTY: true,
      environment: { TERM: "dumb" },
    });

    terminal.progress("다운로드 10%");
    terminal.finish();

    expect(stderr.join("")).toBe("다운로드 10%\n");
    expect(ANSI_PATTERN.test(stderr.join(""))).toBe(false);
  });

  it("leaves exactly one newline when a progress line is active at exit", () => {
    const { terminal, stderr } = capture({ stderrIsTTY: true });

    terminal.progress("완료");
    terminal.finish();
    terminal.finish();

    expect(stderr.join("").endsWith("완료\u001b[0m\n")).toBe(true);
  });

  it("wraps only interactive prose and indents continuation lines", () => {
    const { terminal, stdout } = capture({ stdoutIsTTY: true, stdoutColumns: 28 });

    terminal.stdout("상태: 승인된 Card가 많아서 다음 작업을 확인해야 합니다.");

    expect(stdout.join("")).toMatch(/\n {2}\S/u);
    expect(stripAnsi(stdout.join("")).split("\n").every((line) => line.length <= 28)).toBe(true);
  });

  it("does not split long identifiers or alter JSON on a TTY", () => {
    const identifier = "card_0123456789abcdefghijklmnopqrstuvwxyz";
    const human = capture({ stdoutIsTTY: true, stdoutColumns: 20 });
    human.terminal.stdout(`Card ${identifier} 승인 대기`);
    expect(human.stdout.join("")).toContain(identifier);

    const json = capture({ stdoutIsTTY: true, stdoutColumns: 20 });
    const document = JSON.stringify({ cardId: identifier }, undefined, 2);
    json.terminal.stdout(document);
    expect(stripAnsi(json.stdout.join("")).trim()).toBe(document);
  });

  it("moves structured status details below the verdict on narrow terminals", () => {
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 24,
    });
    const row = "registry  ready      상태 설명이 터미널보다 깁니다";

    terminal.stdout(
      row,
      statusPresentation({
        lane: "registry",
        status: "ready",
        detail: "상태 설명이 터미널보다 깁니다",
      }),
    );

    const lines = stripAnsi(stdout.join("")).trimEnd().split("\n");
    expect(lines[0]).toBe("registry  ready");
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.map((line) => line.trim()).join(" ")).toBe(
      "registry  ready 상태 설명이 터미널보다 깁니다",
    );
    expect(lines.every((line) => testDisplayWidth(line) <= 24)).toBe(true);
  });

  it("stacks a verdict that cannot share a 24-column heading", () => {
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 24,
    });

    terminal.stdout(
      "selection_assets  not_ready  로컬 임베딩 자산을 찾을 수 없습니다.",
      statusPresentation({
        lane: "selection_assets",
        status: "not_ready",
        detail: "로컬 임베딩 자산을 찾을 수 없습니다.",
      }),
    );

    const output = stdout.join("");
    const lines = stripAnsi(output).trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["selection_assets", "  not_ready"]);
    expect(output).toContain("\u001b[31mnot_ready\u001b[0m");
    expect(lines.every((line) => testDisplayWidth(line) <= 24)).toBe(true);
  });

  it.each([24, 40, 80])(
    "keeps mixed-language structured status output within %i columns",
    (columns) => {
      const detail =
        "Qdrant 연결이 지연되어 document retrieval 준비 상태를 확인하고 있습니다.";
      const { terminal, stdout } = capture({
        stdoutIsTTY: true,
        stdoutColumns: columns,
      });

      terminal.stdout(
        `ingestion       degraded   ${detail}`,
        statusPresentation({ lane: "ingestion", status: "degraded", detail }),
      );

      const lines = stripAnsi(stdout.join("")).trimEnd().split("\n");
      expect(lines.every((line) => testDisplayWidth(line) <= columns)).toBe(true);
      const normalized = lines.join(" ").replace(/\s+/gu, " ");
      expect(normalized).toContain("Qdrant");
      expect(normalized).toContain("document retrieval");
    },
  );

  it("keeps the existing three-column status row when 120 columns are enough", () => {
    const row = "registry          ready      Registry 상태가 정상입니다.";
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 120,
      environment: { NO_COLOR: "1" },
    });

    terminal.stdout(
      row,
      statusPresentation({
        lane: "registry",
        status: "ready",
        detail: "Registry 상태가 정상입니다.",
      }),
    );

    expect(stdout.join("")).toBe(`${row}\n`);
  });

  it("does not infer ordinary padded rows as structured status output", () => {
    const row = "name              value that exceeds a narrow terminal";
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 24,
      environment: { NO_COLOR: "1" },
    });

    terminal.stdout(row);

    expect(stdout.join("")).toBe(`${row}\n`);
  });

  it("does not split a long URL in a structured status detail", () => {
    const url = "http://127.0.0.1:6333/collections/contextctl_document_segments_v1";
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 40,
    });

    terminal.stdout(
      `ingestion  not_ready  Qdrant endpoint ${url}`,
      statusPresentation({
        lane: "ingestion",
        status: "not_ready",
        detail: `Qdrant endpoint ${url}`,
      }),
    );

    expect(stripAnsi(stdout.join("")).split(url)).toHaveLength(2);
  });

  it("leaves status output unchanged below the safe wrapping width", () => {
    const row = "registry  ready      a deliberately long status detail";
    const { terminal, stdout } = capture({
      stdoutIsTTY: true,
      stdoutColumns: 19,
      environment: { NO_COLOR: "1" },
    });

    terminal.stdout(
      row,
      statusPresentation({
        lane: "registry",
        status: "ready",
        detail: "a deliberately long status detail",
      }),
    );

    expect(stdout.join("")).toBe(`${row}\n`);
  });
});

function statusPresentation(row: StatusDisplayRow): CliStdoutPresentation {
  return { kind: "status", rows: [row] };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
}

function testDisplayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    width +=
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4c6) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff))
        ? 2
        : 1;
  }
  return width;
}
