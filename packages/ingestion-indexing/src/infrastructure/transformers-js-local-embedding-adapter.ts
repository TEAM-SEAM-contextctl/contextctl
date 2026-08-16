import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertValidEmbeddingProfile,
  embeddingProfilesMatch,
  type DocumentRetrievalEmbeddingProfile,
  type LocalDocumentEmbeddingExecution,
} from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "../ports/embedding.js";

export const LOCAL_EMBEDDING_ASSET_MANIFEST_FILE =
  "contextctl-embedding-assets.v1.json";
const MAX_ASSET_MANIFEST_BYTES = 64 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface LocalEmbeddingAssetFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalEmbeddingAssetManifest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly revision: string;
  readonly license: string;
  readonly files: readonly LocalEmbeddingAssetFile[];
}

export const DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST: LocalEmbeddingAssetManifest =
  Object.freeze({
    schemaVersion: 1,
    repository:
      "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    revision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
    license: "Apache-2.0",
    files: Object.freeze([
      Object.freeze({
        path: "config.json",
        bytes: 1_215,
        sha256:
          "ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee",
      }),
      Object.freeze({
        path: "onnx/model_quantized.onnx",
        bytes: 97_858_099,
        sha256:
          "704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22",
      }),
      Object.freeze({
        path: "special_tokens_map.json",
        bytes: 871,
        sha256:
          "013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69",
      }),
      Object.freeze({
        path: "tokenizer.json",
        bytes: 25_301_671,
        sha256:
          "51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a",
      }),
      Object.freeze({
        path: "tokenizer_config.json",
        bytes: 12_860,
        sha256:
          "6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5",
      }),
    ]),
  });

export const DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256 =
  "200799bc14e4bc0d4087e4e588a58755e3d3bdbfef7e5761e366dfefcd09f069";

export const DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE: DocumentRetrievalEmbeddingProfile =
  Object.freeze({
    id: "document-granite-97m-multilingual-r2-q8-v1",
    version: "1",
    model: "ibm-granite/granite-embedding-97m-multilingual-r2",
    modelRevision: "835ad14087e140460703cf0fae09f97d469d65c2",
    execution: Object.freeze({
      kind: "local",
      adapter: "transformers-js-onnx",
      adapterVersion: "4.2.0",
      artifactRepository:
        "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
      artifactRevision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
      artifactPath: "onnx/model_quantized.onnx",
      artifactSha256:
        "704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22",
      assetManifestSha256:
        DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
      precision: "q8",
    }),
    dimensions: 384,
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
    documentInputTransformVersion: "identity-v1",
    queryInputTransformVersion: "identity-v1",
    modelMaxTokens: 32_768,
    admissionLimit: Object.freeze({
      textMeasureProfileVersion: "unicode-estimate-v1",
      maxUnits: 480,
    }),
    maxInputTokens: 480,
    textMeasureProfileVersion: "unicode-estimate-v1",
  });

export interface LocalFeatureExtractionRuntime {
  tokenCount(text: string): number;
  embed(
    texts: readonly string[],
    options: {
      readonly pooling: "cls" | "mean";
      readonly normalize: true;
    },
  ): Promise<{
    readonly dimensions: readonly number[];
    readonly data: readonly number[];
  }>;
}

export interface LocalFeatureExtractionRuntimeFactory {
  load(input: {
    readonly artifactDirectory: string;
    readonly execution: LocalDocumentEmbeddingExecution;
  }): Promise<LocalFeatureExtractionRuntime>;
}

export interface TransformersJsLocalEmbeddingAdapterOptions {
  readonly artifactDirectory: string;
  readonly profile?: DocumentRetrievalEmbeddingProfile;
  readonly runtimeFactory?: LocalFeatureExtractionRuntimeFactory;
}

/** Offline-only production adapter backed by a verified Transformers.js ONNX model. */
export class TransformersJsLocalEmbeddingAdapter implements EmbeddingPort {
  readonly providerKind = "local" as const;
  readonly #artifactDirectory: string;
  readonly #profile: DocumentRetrievalEmbeddingProfile;
  readonly #runtimeFactory: LocalFeatureExtractionRuntimeFactory;
  #runtime: Promise<LocalFeatureExtractionRuntime> | undefined;

  constructor(options: TransformersJsLocalEmbeddingAdapterOptions) {
    if (!isAbsolute(options.artifactDirectory)) {
      throw new TypeError("embedding artifact directory must be absolute");
    }
    const profile =
      options.profile ?? DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
    assertValidEmbeddingProfile(profile);
    if (profile.execution.kind !== "local") {
      throw new TypeError("local embedding adapter requires a local profile");
    }
    this.#artifactDirectory = options.artifactDirectory;
    this.#profile = structuredClone(profile);
    this.#runtimeFactory =
      options.runtimeFactory ?? new TransformersJsRuntimeFactory();
  }

  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await withAbort(this.#getRuntime(), signal);
  }

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    request.signal.throwIfAborted();
    if (!embeddingProfilesMatch(request.profile, this.#profile)) {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    if (request.inputs.length === 0) return [];
    const runtime = await withAbort(this.#getRuntime(), request.signal);
    for (const input of request.inputs) {
      let count: number;
      try {
        count = runtime.tokenCount(input.text);
      } catch {
        throw new EmbeddingProviderFault("invalid_request", false);
      }
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new EmbeddingProviderFault("invalid_request", false);
      }
      if (count > this.#profile.modelMaxTokens) {
        throw new EmbeddingProviderFault("input_limit_exceeded", false);
      }
    }

    const pooling = this.#profile.pooling;
    if (pooling === "provider_defined") {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    let tensor;
    try {
      tensor = await withAbort(
        runtime.embed(
          request.inputs.map((input) => input.text),
          { pooling, normalize: true },
        ),
        request.signal,
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof EmbeddingProviderFault) throw error;
      throw new EmbeddingProviderFault("provider_unavailable", true);
    }
    return outputsFromTensor(request, tensor, this.#profile.dimensions);
  }

  #getRuntime(): Promise<LocalFeatureExtractionRuntime> {
    this.#runtime ??= this.#loadRuntime();
    return this.#runtime;
  }

  async #loadRuntime(): Promise<LocalFeatureExtractionRuntime> {
    try {
      await verifyLocalEmbeddingAssets(
        this.#artifactDirectory,
        this.#profile,
      );
    } catch (error) {
      if (error instanceof EmbeddingProviderFault) throw error;
      throw new EmbeddingProviderFault(
        "embedding_artifact_unavailable",
        false,
      );
    }
    try {
      return await this.#runtimeFactory.load({
        artifactDirectory: this.#artifactDirectory,
        execution: this.#profile.execution as LocalDocumentEmbeddingExecution,
      });
    } catch (error) {
      if (error instanceof EmbeddingProviderFault) throw error;
      throw new EmbeddingProviderFault("provider_unavailable", false);
    }
  }
}

export async function verifyLocalEmbeddingAssets(
  artifactDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): Promise<LocalEmbeddingAssetManifest> {
  assertValidEmbeddingProfile(profile);
  if (!isAbsolute(artifactDirectory) || profile.execution.kind !== "local") {
    throw artifactUnavailable();
  }
  try {
    const root = await realpath(artifactDirectory);
    if (!(await stat(root)).isDirectory()) throw artifactUnavailable();
    const manifestText = await readVerifiedFile(
      root,
      LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
      MAX_ASSET_MANIFEST_BYTES,
    );
    const manifest = parseAssetManifest(JSON.parse(manifestText.toString("utf8")));
    const execution = profile.execution;
    if (
      manifestDigest(manifest) !== execution.assetManifestSha256 ||
      manifest.repository !== execution.artifactRepository ||
      manifest.revision !== execution.artifactRevision
    ) {
      throw artifactUnavailable();
    }
    const runtimeArtifact = manifest.files.find(
      (file) => file.path === execution.artifactPath,
    );
    if (runtimeArtifact?.sha256 !== execution.artifactSha256) {
      throw artifactUnavailable();
    }
    for (const file of manifest.files) {
      await verifyAssetFile(root, file);
    }
    return manifest;
  } catch (error) {
    if (
      error instanceof EmbeddingProviderFault &&
      error.code === "embedding_artifact_unavailable"
    ) {
      throw error;
    }
    throw artifactUnavailable();
  }
}

export function serializeLocalEmbeddingAssetManifest(
  manifest: LocalEmbeddingAssetManifest,
): string {
  return `${canonicalJson(parseAssetManifest(manifest))}\n`;
}

export function assertProductionEmbeddingProvider(
  profile: DocumentRetrievalEmbeddingProfile,
  provider: EmbeddingPort,
): void {
  assertValidEmbeddingProfile(profile);
  const expectedKind = profile.execution.kind;
  if (provider.providerKind !== expectedKind) {
    throw new TypeError(
      `production ${expectedKind} profile requires an explicit ${expectedKind} provider`,
    );
  }
}

class TransformersJsRuntimeFactory
  implements LocalFeatureExtractionRuntimeFactory
{
  async load(input: {
    readonly artifactDirectory: string;
    readonly execution: LocalDocumentEmbeddingExecution;
  }): Promise<LocalFeatureExtractionRuntime> {
    const { env, mean_pooling, pipeline } = await import(
      "@huggingface/transformers"
    );
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${input.artifactDirectory}${sep}`;
    const extractor = await pipeline(
      "feature-extraction",
      input.artifactDirectory,
      {
        local_files_only: true,
        device: "cpu",
        dtype: input.execution.precision,
        subfolder: dirname(input.execution.artifactPath),
        model_file_name: modelFileName(input.execution),
      },
    );
    return {
      tokenCount: (text) => extractor.tokenizer.encode(text).length,
      embed: async (texts, options) => {
        const modelInputs = extractor.tokenizer([...texts], {
          padding: true,
          truncation: false,
        });
        const modelOutputs = await extractor.model(modelInputs);
        let tensor =
          modelOutputs.last_hidden_state ??
          modelOutputs.logits ??
          modelOutputs.token_embeddings;
        if (tensor === undefined) {
          throw new EmbeddingProviderFault("invalid_response", false);
        }
        tensor =
          options.pooling === "cls"
            ? tensor.slice(null, 0)
            : mean_pooling(tensor, modelInputs.attention_mask);
        tensor = tensor.normalize(2, -1);
        return {
          dimensions: [...tensor.dims],
          data: Array.from(tensor.data, Number),
        };
      },
    };
  }
}

function outputsFromTensor(
  request: EmbeddingProviderRequest,
  tensor: {
    readonly dimensions: readonly number[];
    readonly data: readonly number[];
  },
  dimensions: number,
): readonly EmbeddingProviderOutput[] {
  if (
    tensor.dimensions.length !== 2 ||
    tensor.dimensions[0] !== request.inputs.length ||
    tensor.dimensions[1] !== dimensions ||
    tensor.data.length !== request.inputs.length * dimensions ||
    tensor.data.some((component) => !Number.isFinite(component))
  ) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  return request.inputs.map((input, index) => {
    const vector = tensor.data.slice(
      index * dimensions,
      (index + 1) * dimensions,
    );
    const magnitude = Math.sqrt(
      vector.reduce((sum, component) => sum + component * component, 0),
    );
    if (!Number.isFinite(magnitude) || Math.abs(magnitude - 1) > 0.001) {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return { key: input.key, vector };
  });
}

function parseAssetManifest(input: unknown): LocalEmbeddingAssetManifest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "files",
      "license",
      "repository",
      "revision",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== 1 ||
    !isNonEmptyString(input.repository) ||
    !isNonEmptyString(input.revision) ||
    !isNonEmptyString(input.license) ||
    !Array.isArray(input.files) ||
    input.files.length === 0
  ) {
    throw artifactUnavailable();
  }
  const files = input.files.map((file) => parseAssetFile(file));
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)
  ) {
    throw artifactUnavailable();
  }
  return {
    schemaVersion: 1,
    repository: input.repository,
    revision: input.revision,
    license: input.license,
    files,
  };
}

function parseAssetFile(input: unknown): LocalEmbeddingAssetFile {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["bytes", "path", "sha256"]) ||
    !isSafeRelativePath(input.path) ||
    !Number.isSafeInteger(input.bytes) ||
    (input.bytes as number) <= 0 ||
    typeof input.sha256 !== "string" ||
    !SHA256_HEX.test(input.sha256)
  ) {
    throw artifactUnavailable();
  }
  return {
    path: input.path,
    bytes: input.bytes as number,
    sha256: input.sha256,
  };
}

async function readVerifiedFile(
  root: string,
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (!isSafeRelativePath(path)) throw artifactUnavailable();
  const candidate = resolve(root, path);
  const resolved = await realpath(candidate);
  if (!isWithinRoot(root, resolved)) throw artifactUnavailable();
  const handle = await open(
    resolved,
    fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw artifactUnavailable();
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifyAssetFile(
  root: string,
  expected: LocalEmbeddingAssetFile,
): Promise<void> {
  const resolved = await resolveVerifiedPath(root, expected.path);
  const handle = await open(
    resolved,
    fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes) {
      throw artifactUnavailable();
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    if (digest.digest("hex") !== expected.sha256) {
      throw artifactUnavailable();
    }
  } finally {
    await handle.close();
  }
}

async function resolveVerifiedPath(root: string, path: string): Promise<string> {
  if (!isSafeRelativePath(path)) throw artifactUnavailable();
  const resolved = await realpath(resolve(root, path));
  if (!isWithinRoot(root, resolved)) throw artifactUnavailable();
  return resolved;
}

function manifestDigest(manifest: LocalEmbeddingAssetManifest): string {
  return createHash("sha256")
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");
}

function modelFileName(execution: LocalDocumentEmbeddingExecution): string {
  const suffix =
    execution.precision === "q8"
      ? "_quantized.onnx"
      : execution.precision === "fp16"
        ? "_fp16.onnx"
        : ".onnx";
  const file = basename(execution.artifactPath);
  if (!file.endsWith(suffix) || file.length === suffix.length) {
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  return file.slice(0, -suffix.length);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      )
  );
}

function hasExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(input).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function artifactUnavailable(): EmbeddingProviderFault {
  return new EmbeddingProviderFault("embedding_artifact_unavailable", false);
}

async function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) throw signal.reason;
  if (signal === undefined) return operation;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const onAbort = (): void => rejectAbort?.(signal.reason);
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
