import { describe, expect, it } from "vitest";

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

    terminal.stdout("registry  ready      정상");
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
});

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
}
