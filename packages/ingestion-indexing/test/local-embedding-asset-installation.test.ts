import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DirectoryLocalEmbeddingAssetSource,
  EmbeddingProviderFault,
  installLocalEmbeddingAssets,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  serializeLocalEmbeddingAssetManifest,
  verifyLocalEmbeddingAssets,
  type DocumentRetrievalEmbeddingProfile,
  type LocalEmbeddingAssetManifest,
  type LocalEmbeddingAssetSource,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local embedding asset installation", () => {
  it("verifies every declared byte before the directory becomes readable", async () => {
    const fixture = await createFixture();

    const result = await installLocalEmbeddingAssets({
      profile: fixture.profile,
      manifest: fixture.manifest,
      targetDirectory: fixture.target,
      source: fixture.source,
    });

    expect(result.status).toBe("installed");
    expect(result.installedBytes).toBe(
      fixture.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    await expect(
      verifyLocalEmbeddingAssets(fixture.target, fixture.profile),
    ).resolves.toMatchObject({ revision: fixture.manifest.revision });
    expect((await readdir(fixture.target)).sort()).toEqual(
      [
        LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
        "config.json",
        "onnx",
      ].sort(),
    );
  });

  it("re-runs idempotently without touching installed bytes", async () => {
    const fixture = await createFixture();
    await installLocalEmbeddingAssets({
      profile: fixture.profile,
      manifest: fixture.manifest,
      targetDirectory: fixture.target,
      source: fixture.source,
    });
    fixture.source.reads = 0;

    const again = await installLocalEmbeddingAssets({
      profile: fixture.profile,
      manifest: fixture.manifest,
      targetDirectory: fixture.target,
      source: fixture.source,
    });

    expect(again.status).toBe("already_installed");
    expect(fixture.source.reads).toBe(0);
  });

  it("leaves no partial install when a supplied asset does not match", async () => {
    const fixture = await createFixture();
    fixture.source.corrupt("config.json");

    await expect(
      installLocalEmbeddingAssets({
        profile: fixture.profile,
        manifest: fixture.manifest,
        targetDirectory: fixture.target,
        source: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "embedding_artifact_unavailable" });

    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("keeps the installed revision serving when a later install fails", async () => {
    const fixture = await createFixture();
    await installLocalEmbeddingAssets({
      profile: fixture.profile,
      manifest: fixture.manifest,
      targetDirectory: fixture.target,
      source: fixture.source,
    });
    fixture.source.corrupt("onnx/model_quantized.onnx");
    // Force the installer past its already-installed short circuit.
    await rm(join(fixture.target, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE));

    await expect(
      installLocalEmbeddingAssets({
        profile: fixture.profile,
        manifest: fixture.manifest,
        targetDirectory: fixture.target,
        source: fixture.source,
      }),
    ).rejects.toBeInstanceOf(EmbeddingProviderFault);

    expect(await readFile(join(fixture.target, "config.json"), "utf8")).toBe(
      "{}\n",
    );
    expect(await readdir(fixture.root)).toEqual(["assets"]);
  });

  it("rejects an asset set whose runtime artifact digest differs", async () => {
    const fixture = await createFixture();
    const profile: DocumentRetrievalEmbeddingProfile = {
      ...fixture.profile,
      execution: {
        ...fixture.profile.execution,
        artifactSha256: sha256(Buffer.from("another-model", "utf8")),
      } as DocumentRetrievalEmbeddingProfile["execution"],
    };

    await expect(
      installLocalEmbeddingAssets({
        profile,
        manifest: fixture.manifest,
        targetDirectory: fixture.target,
        source: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "embedding_artifact_unavailable" });
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("installs the same way from an operator-staged directory", async () => {
    const fixture = await createFixture();
    const staged = join(fixture.root, "staged");
    for (const file of fixture.manifest.files) {
      const destination = join(staged, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, fixture.bytes.get(file.path)!);
    }

    const result = await installLocalEmbeddingAssets({
      profile: fixture.profile,
      manifest: fixture.manifest,
      targetDirectory: fixture.target,
      source: new DirectoryLocalEmbeddingAssetSource(staged),
    });

    expect(result.status).toBe("installed");
    await expect(
      verifyLocalEmbeddingAssets(fixture.target, fixture.profile),
    ).resolves.toBeDefined();
  });

  it("refuses a relative target directory", async () => {
    const fixture = await createFixture();

    await expect(
      installLocalEmbeddingAssets({
        profile: fixture.profile,
        manifest: fixture.manifest,
        targetDirectory: "relative/assets",
        source: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "embedding_artifact_unavailable" });
  });
});

class RecordingAssetSource implements LocalEmbeddingAssetSource {
  reads = 0;

  constructor(private readonly bytes: Map<string, Buffer>) {}

  corrupt(path: string): void {
    this.bytes.set(path, Buffer.from("tampered", "utf8"));
  }

  async read(path: string): Promise<Uint8Array> {
    this.reads += 1;
    const bytes = this.bytes.get(path);
    if (bytes === undefined) {
      throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
    }
    return bytes;
  }
}

interface Fixture {
  readonly root: string;
  readonly target: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
  readonly manifest: LocalEmbeddingAssetManifest;
  readonly bytes: Map<string, Buffer>;
  readonly source: RecordingAssetSource;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "contextctl-asset-install-"));
  temporaryDirectories.push(root);
  const configBytes = Buffer.from("{}\n", "utf8");
  const modelBytes = Buffer.from("verified-local-model", "utf8");
  const bytes = new Map([
    ["config.json", configBytes],
    ["onnx/model_quantized.onnx", modelBytes],
  ]);
  const manifest: LocalEmbeddingAssetManifest = {
    schemaVersion: 1,
    repository: "fixture/local-model",
    revision: "fixture-revision",
    license: "Apache-2.0",
    files: [
      { path: "config.json", bytes: configBytes.length, sha256: sha256(configBytes) },
      {
        path: "onnx/model_quantized.onnx",
        bytes: modelBytes.length,
        sha256: sha256(modelBytes),
      },
    ],
  };
  const serialized = serializeLocalEmbeddingAssetManifest(manifest);
  const profile: DocumentRetrievalEmbeddingProfile = {
    id: "fixture-local-q8-v1",
    version: "1",
    model: "fixture/source-model",
    modelRevision: "source-revision",
    execution: {
      kind: "local",
      adapter: "transformers-js-onnx",
      adapterVersion: "4.2.0",
      artifactRepository: manifest.repository,
      artifactRevision: manifest.revision,
      artifactPath: "onnx/model_quantized.onnx",
      artifactSha256: sha256(modelBytes),
      assetManifestSha256: sha256(Buffer.from(serialized.trim(), "utf8")),
      precision: "q8",
    },
    dimensions: 3,
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
    documentInputTransformVersion: "identity-v1",
    queryInputTransformVersion: "identity-v1",
    modelMaxTokens: 512,
    admissionLimit: { maxUnits: 480, textMeasureProfileVersion: "unicode-estimate-v1" },
    maxInputTokens: 480,
    textMeasureProfileVersion: "unicode-estimate-v1",
  };
  return {
    root,
    target: join(root, "assets"),
    profile,
    manifest,
    bytes,
    source: new RecordingAssetSource(bytes),
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
