import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { inspectActiveAssetDirectory } from "./asset-directory.js";
import { resolveContextctlPaths } from "./paths.js";
import { readNonEmpty } from "./paths.js";

/**
 * Everything this tool wrote, and where.
 *
 * There is deliberately no `uninstall` beside it. Two things below are not
 * ours to remove: the Registry database holds Cards an operator
 * approved, and a Qdrant instance is something they started and may be sharing
 * with anything else. A script that deleted both because the binary was being
 * removed would destroy work on the strength of an unrelated intent.
 *
 * So this reports and stops. The operator reads it and deletes what they mean
 * to, which is the only party that knows which of the four they still want.
 */

export type PathEntryKind = "present" | "absent" | "unknown";

export interface PathEntry {
  readonly label: string;
  readonly value: string;
  readonly kind: PathEntryKind;
  /** Bytes on disk, when the entry is something measurable that exists. */
  readonly bytes?: number;
  /** One line of context — why this matters when removing it. */
  readonly note?: string;
}

export interface PathsReport {
  readonly groups: readonly {
    readonly title: string;
    readonly entries: readonly PathEntry[];
  }[];
}

export async function buildPathsReport(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
}): Promise<PathsReport> {
  const paths = resolveContextctlPaths(input.environment, input.workingDirectory);

  return {
    groups: [
      {
        title: "상태 (지우면 등록한 소스와 승인한 Card 가 사라집니다)",
        entries: [
          await fileEntry(
            "상태 디렉터리",
            paths.home,
            "영속 상태 네 파일과 실행 중 임시 상태를 담습니다.",
          ),
          await fileEntry("Source 설정", paths.sourcesFile, "등록한 문서 목록입니다."),
          await fileEntry(
            "Registry 저장소",
            paths.registryDatabase,
            "Card 와 승인 이력. 지우면 다시 승인해야 합니다.",
          ),
          await fileEntry(
            "Ingestion 저장소",
            paths.ingestionDatabase,
            "관측·게시 이력. 지우면 같은 문서를 다시 수집합니다.",
          ),
          await fileEntry(
            "Selection 감사 저장소",
            paths.selectionAuditDatabase,
            "원문을 제외한 선택 판정 기록. 30일·1만 건·256 MiB 한도로 정리됩니다.",
          ),
        ],
      },
      {
        title: "실행 중 임시 상태 (daemon 종료 시 사라집니다)",
        entries: [
          await fileEntry(
            "실행 상태",
            paths.runtimeActivityDirectory,
            "serve 프로세스별 queue·RSS·event loop 수치만 담습니다.",
          ),
        ],
      },
      {
        title: "임베딩 모델 (다시 받으면 되지만 큽니다)",
        entries: await assetEntries(paths.embeddingAssetDirectory),
      },
      {
        title: "벡터 색인 (contextctl 이 띄운 것이 아닙니다)",
        entries: [vectorEntry(input.environment)],
      },
      {
        title: "설치된 명령",
        entries: installationEntries(),
      },
    ],
  };
}

/**
 * The managed root plus the revision the pointer names.
 *
 * Resolved through the shared module, never by joining `revisions/<digest>`
 * here: the composition and the diagnosis already disagreed once about which of
 * the two directories the assets are in, and a third assembler would be a third
 * chance to disagree.
 */
async function assetEntries(managedRoot: string): Promise<readonly PathEntry[]> {
  const root = await fileEntry(
    "자산 루트",
    managedRoot,
    "통째로 지워도 contextctl install-assets 로 복구됩니다.",
  );
  const resolution = await inspectActiveAssetDirectory(managedRoot);
  if (resolution.status !== "resolved") {
    return [
      root,
      {
        label: "현재 revision",
        value: "(설치되지 않음)",
        kind: "absent",
        note: "contextctl install-assets 로 설치합니다.",
      },
    ];
  }
  try {
    const bytes = await directoryBytes(resolution.directory);
    return [
      root,
      {
        label: "현재 revision",
        value: resolution.directory,
        kind: "present",
        bytes,
        note: "실제 설치 용량입니다. 이 디렉터리만 지우면 모델이 사라집니다.",
      },
    ];
  } catch {
    return [
      root,
      {
        label: "현재 revision",
        value: resolution.directory,
        kind: "unknown",
        note: "포인터 대상의 실제 용량을 읽을 수 없습니다. 권한과 설치 상태를 확인하십시오.",
      },
    ];
  }
}

/** Counts regular files without following links outside the managed revision. */
async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(path);
    } else if (entry.isFile()) {
      bytes += (await stat(path)).size;
    }
  }
  return bytes;
}

function vectorEntry(
  environment: Readonly<Partial<Record<string, string>>>,
): PathEntry {
  const url = readNonEmpty(environment, "CONTEXTCTL_QDRANT_URL");
  if (url === undefined) {
    return {
      label: "Qdrant",
      value: "(설정되지 않음 — ingest, query, serve를 실행할 수 없습니다)",
      kind: "absent",
      note: "CONTEXTCTL_QDRANT_URL을 설정하십시오. 인메모리 색인은 시험 전용이며 운영 대체 경로가 아닙니다.",
    };
  }
  return {
    label: "Qdrant",
    value: url,
    kind: "present",
    // Not enumerated, and not deleted. This server may hold collections that
    // have nothing to do with contextctl, and guessing which are ours from a
    // name is how an unrelated dataset gets dropped.
    note: "여기에 컬렉션이 남습니다. contextctl 은 이 서버를 띄우지 않았으므로 직접 확인하고 지우십시오.",
  };
}

/**
 * Where the command itself lives, and under which Node.
 *
 * The Node version is part of the answer rather than trivia: `fnm` and `nvm`
 * install a package's `bin` into the active version's directory only, so
 * switching versions and installing again leaves a second copy that `npm
 * uninstall -g` under one version will not remove. An operator who does not
 * know that removes the command, switches shells, and finds it still there.
 */
function installationEntries(): readonly PathEntry[] {
  const entry = process.argv[1];
  return [
    {
      label: "실행 파일",
      value: entry ?? "(알 수 없음)",
      kind: entry === undefined ? "unknown" : "present",
      note: "npm uninstall -g @contextctl/daemon 로 제거합니다.",
    },
    {
      label: "Node",
      // `execPath`, not the module's own directory: under a version manager the
      // interpreter path is the thing that differs between versions, and it is
      // what tells an operator which installation they are looking at.
      value: `${process.version} — ${process.execPath}`,
      kind: "present",
      note: "fnm·nvm 을 쓴다면 이 버전에만 설치돼 있습니다. 다른 버전으로 바꿔 설치한 적이 있다면 그쪽도 확인하십시오.",
    },
  ];
}

async function fileEntry(
  label: string,
  value: string,
  note: string,
): Promise<PathEntry> {
  try {
    const metadata = await stat(value);
    return {
      label,
      value,
      kind: "present",
      ...(metadata.isFile() ? { bytes: metadata.size } : {}),
      note,
    };
  } catch {
    // Absent is a normal answer here, not a failure: this command is often the
    // first one an operator runs, before anything has been created.
    return { label, value, kind: "absent", note };
  }
}

/** `1.2 GiB`, or `—` when nothing was measured. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "—";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit] ?? "B"}`;
}

/** Kept out of the report builder so a test can assert paths without a tty. */
export function renderPathsReport(report: PathsReport): string {
  const lines: string[] = [];
  for (const group of report.groups) {
    lines.push(group.title);
    for (const entry of group.entries) {
      const mark = entry.kind === "present" ? "•" : entry.kind === "absent" ? "·" : "?";
      const size = entry.bytes === undefined ? "" : `  [${formatBytes(entry.bytes)}]`;
      lines.push(`  ${mark} ${entry.label}: ${entry.value}${size}`);
      if (entry.note !== undefined) {
        lines.push(`      ${entry.note}`);
      }
    }
    lines.push("");
  }
  lines.push("이 명령은 아무것도 지우지 않습니다. 위 경로를 보고 직접 지우십시오.");
  return lines.join("\n");
}
