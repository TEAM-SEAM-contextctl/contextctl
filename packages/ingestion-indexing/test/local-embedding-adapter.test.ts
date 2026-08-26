import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  DeterministicEmbeddingAdapter,
  EmbeddingPipeline,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  TransformersJsLocalEmbeddingAdapter,
  assertProductionEmbeddingProvider,
  documentEmbeddingProfileChangeRequiresFullRebuild,
  embeddingProfilesMatch,
  serializeLocalEmbeddingAssetManifest,
  validateEmbeddingProfile,
  verifyLocalEmbeddingAssets,
  type DocumentRetrievalEmbeddingProfile,
  type LocalEmbeddingAssetManifest,
  type LocalDocumentEmbeddingExecution,
  type LocalFeatureExtractionRuntime,
  type LocalFeatureExtractionRuntimeFactory,
} from "../src/index.js";
import { createManagedChunkFixture } from "./fixtures/document-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("document retrieval embedding profile", () => {
  it("pins the complete Granite fp32 vector semantics and asset set", () => {
    expect(validateEmbeddingProfile(DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE))
      .toEqual([]);
    expect(DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE).toMatchObject({
      id: "document-granite-97m-multilingual-r2-fp32-v1",
      modelRevision: "835ad14087e140460703cf0fae09f97d469d65c2",
      dimensions: 384,
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
      modelMaxTokens: 32_768,
      admissionLimit: {
        maxUnits: 480,
        textMeasureProfileVersion: "unicode-estimate-v1",
      },
      execution: {
        kind: "local",
        adapter: "transformers-js-onnx",
        adapterVersion: "4.2.0",
        precision: "fp32",
        artifactPath: "onnx/model.onnx",
      },
    });
    expect(
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution.kind === "local"
        ? DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution
            .assetManifestSha256
        : undefined,
    ).toBe(DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256);
    expect(DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files.map((file) => file.path))
      .toEqual([
        "config.json",
        "onnx/model.onnx",
        "special_tokens_map.json",
        "tokenizer.json",
        "tokenizer_config.json",
      ]);
    expect(
      digest(
        Buffer.from(
          serializeLocalEmbeddingAssetManifest(
            DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
          ).trim(),
          "utf8",
        ),
      ),
    ).toBe(DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256);
  });

  it("requires a full rebuild for every vector-semantics change", () => {
    const profile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
    const changed = {
      ...profile,
      execution: {
        ...profile.execution,
        artifactSha256: "f".repeat(64),
      },
    } as DocumentRetrievalEmbeddingProfile;

    expect(embeddingProfilesMatch(profile, structuredClone(profile))).toBe(true);
    expect(documentEmbeddingProfileChangeRequiresFullRebuild(profile, changed))
      .toBe(true);
  });

  it("rejects incomplete or internally inconsistent production semantics", () => {
    expect(
      validateEmbeddingProfile({
        ...DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        maxInputTokens: 481,
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: "relationship_mismatch",
        path: "embeddingProfile.admissionLimit",
      }),
    );
    expect(
      validateEmbeddingProfile({
        ...DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        execution: {
          ...DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution,
          artifactPath: "../model.onnx",
        },
      } as DocumentRetrievalEmbeddingProfile),
    ).toContainEqual(
      expect.objectContaining({ path: "embeddingProfile.execution.artifactPath" }),
    );
    expect(
      validateEmbeddingProfile({
        ...DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        queryInputTransformVersion: "implicit-provider-default",
      } as DocumentRetrievalEmbeddingProfile),
    ).toContainEqual(
      expect.objectContaining({
        path: "embeddingProfile.queryInputTransformVersion",
      }),
    );
  });
});

describe("Transformers.js local embedding adapter", () => {
  it("verifies every local asset before loading and preserves exact input semantics", async () => {
    const fixture = await createAssetFixture();
    const factory = new RecordingRuntimeFactory();
    const adapter = new TransformersJsLocalEmbeddingAdapter({
      artifactDirectory: fixture.artifactDirectory,
      profile: fixture.profile,
      runtimeFactory: factory,
    });

    const result = await adapter.embed({
      profile: fixture.profile,
      inputs: [
        { key: "document", text: "문서 원문" },
        { key: "query", text: "검색 질의" },
      ],
      signal: new AbortController().signal,
    });

    expect(factory.loads).toHaveLength(1);
    expect(factory.runtime.texts).toEqual([["문서 원문", "검색 질의"]]);
    expect(factory.runtime.options).toEqual([
      { pooling: "cls", normalize: true },
    ]);
    expect(result).toEqual([
      { key: "document", vector: [1, 0, 0] },
      { key: "query", vector: [1, 0, 0] },
    ]);
    await adapter.ready();
    expect(factory.loads).toHaveLength(1);
  });

  it("accepts only an execution-matched minimal inference resource", async () => {
    const fixture = await createAssetFixture();
    const execution = fixture.profile.execution;
    if (execution.kind !== "local") {
      throw new Error("fixture must use local execution");
    }
    const resource = new RecordingRuntime();
    resource.execution = execution;
    const adapter = new TransformersJsLocalEmbeddingAdapter({
      profile: fixture.profile,
      inferenceResource: resource,
    });

    await expect(
      adapter.embed({
        profile: fixture.profile,
        inputs: [{ key: "query", text: "공유 세션 질의" }],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([{ key: "query", vector: [1, 0, 0] }]);
    expect(resource.texts).toEqual([["공유 세션 질의"]]);

    expect(
      () =>
        new TransformersJsLocalEmbeddingAdapter({
          profile: fixture.profile,
          inferenceResource: {
            execution: {
              ...execution,
              artifactSha256: "f".repeat(64),
            },
            modelMaxTokens: resource.modelMaxTokens,
            tokenCount: (text) => resource.tokenCount(text),
            embed: (texts, options) => resource.embed(texts, options),
          },
        }),
    ).toThrow(/does not match/);
  });

  it("materializes transferred fp32 data as owned document vectors", async () => {
    const fixture = await createAssetFixture();
    const execution = fixture.profile.execution;
    if (execution.kind !== "local") {
      throw new Error("fixture must use local execution");
    }
    const data = new Float32Array([1, 0, 0]);
    const adapter = new TransformersJsLocalEmbeddingAdapter({
      profile: fixture.profile,
      inferenceResource: {
        execution,
        modelMaxTokens: fixture.profile.modelMaxTokens,
        tokenCount: () => 2,
        embed: async () => ({ dimensions: [1, 3], data }),
      },
    });

    const output = await adapter.embed({
      profile: fixture.profile,
      inputs: [{ key: "query", text: "검색 질의" }],
      signal: new AbortController().signal,
    });

    expect(output).toEqual([{ key: "query", vector: [1, 0, 0] }]);
    expect(Array.isArray(output[0]?.vector)).toBe(true);
    data.fill(0);
    expect(output[0]?.vector).toEqual([1, 0, 0]);
  });

  it("fails closed for a missing, changed, or escaping asset", async () => {
    const missing = await createAssetFixture();
    await rm(join(missing.artifactDirectory, "model_quantized.onnx"));
    await expect(
      verifyLocalEmbeddingAssets(missing.artifactDirectory, missing.profile),
    ).rejects.toMatchObject({
      code: "embedding_artifact_unavailable",
      retriable: false,
    });

    const changed = await createAssetFixture();
    await writeFile(
      join(changed.artifactDirectory, "model_quantized.onnx"),
      "tampered",
    );
    await expect(
      verifyLocalEmbeddingAssets(changed.artifactDirectory, changed.profile),
    ).rejects.toMatchObject({ code: "embedding_artifact_unavailable" });

    const escaping = await createAssetFixture({ symlinkedArtifact: true });
    await expect(
      verifyLocalEmbeddingAssets(escaping.artifactDirectory, escaping.profile),
    ).rejects.toMatchObject({ code: "embedding_artifact_unavailable" });
  });

  it("distinguishes tokenizer overflow from artifact failure without truncation", async () => {
    const fixture = await createAssetFixture();
    const factory = new RecordingRuntimeFactory();
    factory.runtime.tokenCounts.set("oversized", 9);
    const adapter = new TransformersJsLocalEmbeddingAdapter({
      artifactDirectory: fixture.artifactDirectory,
      profile: fixture.profile,
      runtimeFactory: factory,
    });

    await expect(
      adapter.embed({
        profile: fixture.profile,
        inputs: [{ key: "query", text: "oversized" }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "input_limit_exceeded",
      retriable: false,
    });
    expect(factory.runtime.texts).toEqual([]);

    const chunk = createManagedChunkFixture()[0]!;
    await expect(
      new EmbeddingPipeline({ provider: adapter }).embed({
        chunks: [{ ...chunk, text: "oversized" }],
        profile: fixture.profile,
      }),
    ).rejects.toMatchObject({ code: "input_limit_exceeded" });
  });

  it("rejects wrong profiles, malformed shapes, and non-normalized vectors", async () => {
    const fixture = await createAssetFixture();
    const factory = new RecordingRuntimeFactory();
    const adapter = new TransformersJsLocalEmbeddingAdapter({
      artifactDirectory: fixture.artifactDirectory,
      profile: fixture.profile,
      runtimeFactory: factory,
    });
    await expect(
      adapter.embed({
        profile: { ...fixture.profile, version: "other" },
        inputs: [{ key: "query", text: "hello" }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    factory.runtime.vector = [0.5, 0, 0];
    await expect(
      adapter.embed({
        profile: fixture.profile,
        inputs: [{ key: "query", text: "hello" }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not allow the deterministic test adapter in production composition", () => {
    expect(() =>
      assertProductionEmbeddingProvider(
        DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        new DeterministicEmbeddingAdapter(),
      ),
    ).toThrow(TypeError);
  });
});

interface AssetFixture {
  readonly artifactDirectory: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
}

async function createAssetFixture(
  options: { readonly symlinkedArtifact?: boolean } = {},
): Promise<AssetFixture> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-embedding-assets-"));
  temporaryDirectories.push(directory);
  const artifactDirectory = join(directory, "assets");
  await mkdir(artifactDirectory);
  const modelBytes = Buffer.from("verified-local-model", "utf8");
  const configBytes = Buffer.from("{}\n", "utf8");
  const manifest: LocalEmbeddingAssetManifest = {
    schemaVersion: 1,
    repository: "fixture/local-model",
    revision: "fixture-revision",
    license: "Apache-2.0",
    files: [
      {
        path: "config.json",
        bytes: configBytes.length,
        sha256: digest(configBytes),
      },
      {
        path: "model_quantized.onnx",
        bytes: modelBytes.length,
        sha256: digest(modelBytes),
      },
    ],
  };
  await writeFile(join(artifactDirectory, "config.json"), configBytes);
  if (options.symlinkedArtifact === true) {
    const outside = join(directory, "outside-model.onnx");
    await writeFile(outside, modelBytes);
    await symlink(outside, join(artifactDirectory, "model_quantized.onnx"));
  } else {
    await writeFile(
      join(artifactDirectory, "model_quantized.onnx"),
      modelBytes,
    );
  }
  const serialized = serializeLocalEmbeddingAssetManifest(manifest);
  await writeFile(
    join(artifactDirectory, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE),
    serialized,
  );
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
      artifactPath: "model_quantized.onnx",
      artifactSha256: digest(modelBytes),
      assetManifestSha256: digest(Buffer.from(serialized.trim(), "utf8")),
      precision: "q8",
    },
    dimensions: 3,
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
    documentInputTransformVersion: "identity-v1",
    queryInputTransformVersion: "identity-v1",
    modelMaxTokens: 8,
    admissionLimit: {
      textMeasureProfileVersion: "unicode-estimate-v1",
      maxUnits: 480,
    },
    maxInputTokens: 480,
    textMeasureProfileVersion: "unicode-estimate-v1",
  };
  return { artifactDirectory, profile };
}

class RecordingRuntimeFactory implements LocalFeatureExtractionRuntimeFactory {
  readonly loads: unknown[] = [];
  readonly runtime = new RecordingRuntime();

  async load(input: {
    readonly artifactDirectory: string;
    readonly execution: LocalDocumentEmbeddingExecution;
    readonly modelMaxTokens: number;
  }): Promise<LocalFeatureExtractionRuntime> {
    this.loads.push(input);
    this.runtime.execution = input.execution;
    return this.runtime;
  }
}

class RecordingRuntime implements LocalFeatureExtractionRuntime {
  execution = {} as LocalDocumentEmbeddingExecution;
  modelMaxTokens = 8;
  readonly texts: string[][] = [];
  readonly options: unknown[] = [];
  readonly tokenCounts = new Map<string, number>();
  vector = [1, 0, 0];

  tokenCount(text: string): number {
    return this.tokenCounts.get(text) ?? 2;
  }

  async embed(
    texts: readonly string[],
    options: { readonly pooling: "cls" | "mean"; readonly normalize: true },
  ) {
    this.texts.push([...texts]);
    this.options.push(options);
    return {
      dimensions: [texts.length, this.vector.length],
      data: texts.flatMap(() => this.vector),
    };
  }
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
