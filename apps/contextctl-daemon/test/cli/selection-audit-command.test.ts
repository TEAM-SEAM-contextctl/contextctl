import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSelectionAuditRecord,
  InMemoryCardCatalog,
  selectContext,
} from "@contextctl/selection-delivery";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
} from "../../src/main.js";
import { runSelectionAuditCommand } from "../../src/cli/selection-audit-command.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";
import {
  openSelectionAuditDatabase,
  SqliteSelectionAuditStore,
} from "../../src/selection-audit/sqlite-selection-audit-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "contextctl-audit-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function invoke(
  stateHome: string,
  command:
    | {
        readonly kind: "audit_list";
        readonly limit: number;
        readonly json: boolean;
      }
    | {
        readonly kind: "audit_show";
        readonly auditId: string;
        readonly json: boolean;
      },
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const outcome = await runSelectionAuditCommand({
    command,
    environment: { CONTEXTCTL_HOME: stateHome },
    workingDirectory: stateHome,
  });
  return {
    code: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr.join("\n"),
  };
}

describe("selection audit CLI", () => {
  it("lists an empty protected store without requiring models or Qdrant", async () => {
    const result = await invoke(home(), {
      kind: "audit_list",
      limit: 20,
      json: true,
    });

    expect(result).toEqual({ code: 0, stdout: "[]", stderr: "" });
  });

  it("shows a persisted text-free record in human and JSON forms", async () => {
    const stateHome = home();
    const environment = { CONTEXTCTL_HOME: stateHome };
    const paths = resolveContextctlPaths(environment, stateHome);
    const database = openSelectionAuditDatabase({
      location: paths.selectionAuditDatabase,
      stateIdentity: {
        stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
        securityDomain: DEFAULT_SECURITY_DOMAIN,
      },
    });
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog([]) },
      "비밀 질의 원문",
    );
    const record = createSelectionAuditRecord({
      plan,
      auditId: "sa_00000000000000000000000000000001",
      recordedAt: "2026-08-27T00:00:00.000Z",
    });
    await new SqliteSelectionAuditStore(database).append(record);
    database.close();

    const listed = await invoke(stateHome, {
      kind: "audit_list",
      limit: 20,
      json: false,
    });
    const shown = await invoke(stateHome, {
      kind: "audit_show",
      auditId: record.auditId,
      json: true,
    });

    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(record.auditId);
    expect(listed.stdout).not.toContain("비밀 질의 원문");
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(record);
    expect(shown.stdout).not.toContain("비밀 질의 원문");
  });
});
