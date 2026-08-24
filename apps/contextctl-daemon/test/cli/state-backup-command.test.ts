import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openIngestionDatabase } from "@contextctl/ingestion-indexing";
import { openRegistryDatabase } from "@contextctl/registry-lifecycle";

import { runStateBackupCommand } from "../../src/cli/state-backup-command.js";
import type {
  StateBackupQdrantArtifact,
  VectorSnapshotArchive,
  VectorSnapshotRestoreLease,
} from "../../src/operations/state-backup.js";

const directories: string[] = [];
const environment = {
  CONTEXTCTL_STATE_NAMESPACE_ID: "backup_cli_test",
  CONTEXTCTL_SECURITY_DOMAIN: "backup-cli",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("state backup CLI command", () => {
  it("refuses an invalid shared identity before touching backup state", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "contextctl-backup-cli-"));
    directories.push(workingDirectory);

    await expect(
      runStateBackupCommand({
        command: { kind: "backup_create", destination: "backup" },
        environment: {
          ...environment,
          CONTEXTCTL_SECURITY_DOMAIN: " ",
        },
        workingDirectory,
        vectors: new EmptyVectorArchive(),
      }),
    ).rejects.toMatchObject({
      code: "state_identity_invalid",
      field: "securityDomain",
    });
    await expect(access(join(workingDirectory, "backup"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates and restores state without constructing the model runtime", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "contextctl-backup-cli-"));
    directories.push(workingDirectory);
    const home = join(workingDirectory, "state");
    await mkdir(home);
    const configured = { ...environment, CONTEXTCTL_HOME: home };
    openIngestionDatabase({
      location: join(home, "ingestion.db"),
      stateNamespaceId: environment.CONTEXTCTL_STATE_NAMESPACE_ID,
      securityDomain: environment.CONTEXTCTL_SECURITY_DOMAIN,
    }).close();
    openRegistryDatabase({
      location: join(home, "registry.db"),
      stateNamespaceId: environment.CONTEXTCTL_STATE_NAMESPACE_ID,
      securityDomain: environment.CONTEXTCTL_SECURITY_DOMAIN,
    }).close();
    const vectors = new EmptyVectorArchive();

    const created = await runStateBackupCommand({
      command: { kind: "backup_create", destination: "backup" },
      environment: configured,
      workingDirectory,
      vectors,
    });
    const restored = await runStateBackupCommand({
      command: {
        kind: "backup_restore",
        source: "backup",
        targetHome: "restored",
      },
      environment: configured,
      workingDirectory,
      vectors,
    });

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain(join(workingDirectory, "backup"));
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain("CONTEXTCTL_HOME=");
    await expect(access(join(workingDirectory, "restored", "ingestion.db")))
      .resolves.toBeUndefined();
    await expect(access(join(workingDirectory, "restored", "registry.db")))
      .resolves.toBeUndefined();
  });
});

class EmptyVectorArchive implements VectorSnapshotArchive {
  async create(): Promise<readonly StateBackupQdrantArtifact[]> {
    return [];
  }

  async restore(): Promise<VectorSnapshotRestoreLease> {
    return { rollback: async () => undefined };
  }
}
