import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  QdrantSnapshotArchive,
  QdrantSnapshotArchiveError,
} from "../../src/operations/qdrant-snapshot-archive.js";

const collectionName = `contextctl_${"a".repeat(32)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Qdrant snapshot archive", () => {
  it("downloads an exact collection snapshot and removes the server temporary", async () => {
    const directory = await temporaryDirectory();
    const requests: Array<{ readonly method: string; readonly url: string; readonly apiKey: string | null }> = [];
    const archive = new QdrantSnapshotArchive({
      url: "http://127.0.0.1:6333",
      apiKey: "test-secret",
      fetch: async (request, init) => {
        const url = String(request);
        requests.push({
          method: init?.method ?? "GET",
          url,
          apiKey: new Headers(init?.headers).get("api-key"),
        });
        if (init?.method === "POST") {
          return json({
            status: "ok",
            result: {
              name: "snapshot-1.snapshot",
              checksum: "qdrant-checksum",
            },
          });
        }
        if (init?.method === "GET") {
          return new Response(Uint8Array.from([1, 2, 3, 4]));
        }
        return json({ status: "ok", result: true });
      },
    });

    const artifacts = await archive.create({
      targets: [{ collectionName }],
      directory,
    });

    expect(artifacts).toEqual([
      {
        collectionName,
        path: `qdrant/${collectionName}.snapshot`,
        sizeBytes: 4,
        sha256:
          "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        qdrantChecksum: "qdrant-checksum",
      },
    ]);
    expect(
      await readFile(join(directory, `${collectionName}.snapshot`)),
    ).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "DELETE",
    ]);
    expect(requests.every((request) => request.apiKey === "test-secret"))
      .toBe(true);
    expect(JSON.stringify(artifacts)).not.toContain("test-secret");
  });

  it("restores only into an absent collection and can roll it back", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, `${collectionName}.snapshot`);
    await writeFile(path, Uint8Array.from([9, 8, 7]));
    let existsChecks = 0;
    const methods: string[] = [];
    const archive = new QdrantSnapshotArchive({
      url: "http://127.0.0.1:6333",
      fetch: async (request, init) => {
        methods.push(init?.method ?? "GET");
        const url = String(request);
        if (url.endsWith("/exists")) {
          existsChecks += 1;
          return json({
            status: "ok",
            result: { exists: existsChecks > 1 },
          });
        }
        return json({ status: "ok", result: true });
      },
    });

    const lease = await archive.restore({
      directory,
      artifacts: [
        {
          collectionName,
          path: `qdrant/${collectionName}.snapshot`,
          sizeBytes: 3,
          sha256: "0".repeat(64),
        },
      ],
    });
    await lease.rollback();
    await lease.rollback();

    expect(methods).toEqual(["GET", "POST", "GET", "DELETE"]);
  });

  it("refuses an existing collection before uploading any bytes", async () => {
    const methods: string[] = [];
    const archive = new QdrantSnapshotArchive({
      url: "http://127.0.0.1:6333",
      fetch: async (_request, init) => {
        methods.push(init?.method ?? "GET");
        return json({ status: "ok", result: { exists: true } });
      },
    });

    await expect(
      archive.restore({
        directory: "/does/not/matter",
        artifacts: [
          {
            collectionName,
            path: `qdrant/${collectionName}.snapshot`,
            sizeBytes: 1,
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<QdrantSnapshotArchiveError>>({
      code: "collection_already_exists",
    });
    expect(methods).toEqual(["GET"]);
  });

  it("rejects an unsafe endpoint before making requests", () => {
    expect(
      () =>
        new QdrantSnapshotArchive({
          url: "http://qdrant.example.test:6333",
        }),
    ).toThrow(TypeError);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-qdrant-backup-"));
  directories.push(directory);
  return directory;
}
