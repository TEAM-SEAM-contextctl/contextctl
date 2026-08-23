import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { DEFAULT_SECURITY_DOMAIN, DEFAULT_STATE_NAMESPACE_ID } from "../main.js";
import { QdrantSnapshotArchive } from "../operations/qdrant-snapshot-archive.js";
import {
  createStateBackup,
  restoreStateBackup,
  type StateBackupIdentity,
  type VectorSnapshotArchive,
} from "../operations/state-backup.js";
import { readQdrantConnectionOptions } from "../vector-backend.js";
import type { CliCommand } from "./arguments.js";
import { ok, type CommandOutcome } from "./commands.js";
import { resolveContextctlPaths } from "./paths.js";

type BackupCommand = Extract<
  CliCommand,
  { readonly kind: "backup_create" | "backup_restore" }
>;

/** Runs backup and restore without constructing an embedding or query runtime. */
export async function runStateBackupCommand(input: {
  readonly command: BackupCommand;
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory: string;
  /** Test seam; production always constructs the configured Qdrant archive. */
  readonly vectors?: VectorSnapshotArchive;
}): Promise<CommandOutcome> {
  const identity = readStateBackupIdentity(input.environment);
  const vectors =
    input.vectors ??
    new QdrantSnapshotArchive(
      readQdrantConnectionOptions(input.environment),
    );

  if (input.command.kind === "backup_create") {
    const paths = resolveContextctlPaths(
      input.environment,
      input.workingDirectory,
    );
    const sourcesFile = await existingPathOrUndefined(paths.sourcesFile);
    const destination = absoluteFrom(
      input.workingDirectory,
      input.command.destination,
    );
    const manifest = await createStateBackup({
      destination,
      identity,
      paths: {
        ingestionDatabase: paths.ingestionDatabase,
        registryDatabase: paths.registryDatabase,
        ...(sourcesFile === undefined ? {} : { sourcesFile }),
      },
      vectors,
    });
    return ok([
      `상태 백업을 만들었다: ${destination}`,
      `  백업 ID: ${manifest.backupId}`,
      `  SQLite: ${String(manifest.sqlite.length)}개`,
      `  Qdrant 컬렉션: ${String(manifest.qdrant.length)}개`,
      "",
      "복원할 때는 기존 상태를 덮어쓰지 말고 backup restore --target-home <새 디렉터리>를 사용하십시오.",
    ].join("\n"));
  }

  const source = absoluteFrom(input.workingDirectory, input.command.source);
  const targetHome = absoluteFrom(
    input.workingDirectory,
    input.command.targetHome,
  );
  const manifest = await restoreStateBackup({
    source,
    destinationHome: targetHome,
    expectedIdentity: identity,
    vectors,
  });
  return ok([
    `상태 백업을 새 디렉터리에 복원했다: ${targetHome}`,
    `  백업 ID: ${manifest.backupId}`,
    `  Qdrant 컬렉션: ${String(manifest.qdrant.length)}개`,
    "",
    `검증 후 CONTEXTCTL_HOME=${targetHome} 로 전환하십시오.`,
    "개별 DB 경로 환경 변수를 사용 중이라면 새 홈의 ingestion.db와 registry.db를 가리키도록 함께 바꾸십시오.",
  ].join("\n"));
}

function readStateBackupIdentity(
  environment: Readonly<Partial<Record<string, string>>>,
): StateBackupIdentity {
  return {
    stateNamespaceId:
      environment.CONTEXTCTL_STATE_NAMESPACE_ID ??
      DEFAULT_STATE_NAMESPACE_ID,
    securityDomain:
      environment.CONTEXTCTL_SECURITY_DOMAIN ?? DEFAULT_SECURITY_DOMAIN,
  };
}

function absoluteFrom(workingDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workingDirectory, path);
}

async function existingPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
