import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { Tokenizer, type Encoding } from "@huggingface/tokenizers";
import * as onnx from "onnxruntime-node";

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
        path: "onnx/model.onnx",
        bytes: 390_004_608,
        sha256:
          "68e592b160673d30250824c1116bc6ab33f70efb22b97c9e1d7ce1e69c1c9d70",
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
  "eb0923125496145fce8105135180b42f37d098c688837037d73e4ba11bd8c389";

export const DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE: DocumentRetrievalEmbeddingProfile =
  Object.freeze({
    id: "document-granite-97m-multilingual-r2-fp32-v1",
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
      artifactPath: "onnx/model.onnx",
      artifactSha256:
        "68e592b160673d30250824c1116bc6ab33f70efb22b97c9e1d7ce1e69c1c9d70",
      assetManifestSha256:
        DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
      precision: "fp32",
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

/**
 * Minimal, stateless inference resource consumed by the document adapter.
 *
 * The daemon may inject the same physical object into another domain adapter
 * when its execution semantics match. This object is deliberately not an
 * `EmbeddingPort`: profile checks, input transforms, output validation and
 * domain faults remain in this adapter.
 */
export interface LocalDocumentEmbeddingInferenceResource {
  readonly execution: LocalDocumentEmbeddingExecution;
  /** The tokenizer limit of the loaded model, independent of product admission. */
  readonly modelMaxTokens: number;
  tokenCount(text: string): number | Promise<number>;
  embed(
    texts: readonly string[],
    options: {
      readonly pooling: "cls" | "mean";
      readonly normalize: true;
    },
  ): Promise<{
    readonly dimensions: readonly number[];
    readonly data: readonly number[] | Float32Array;
  }>;
}

/** Pre-release compatibility alias for existing resource factories. */
export type LocalFeatureExtractionRuntime =
  LocalDocumentEmbeddingInferenceResource;

export interface LocalFeatureExtractionRuntimeFactory {
  load(input: {
    readonly artifactDirectory: string;
    readonly execution: LocalDocumentEmbeddingExecution;
    readonly modelMaxTokens: number;
  }): Promise<LocalFeatureExtractionRuntime>;
}

export interface TransformersJsLocalEmbeddingAdapterOptions {
  /** Creates and verifies a private local resource when supplied. */
  readonly artifactDirectory?: string;
  readonly profile?: DocumentRetrievalEmbeddingProfile;
  readonly runtimeFactory?: LocalFeatureExtractionRuntimeFactory;
  /** Uses a composition-owned, already verified physical resource. */
  readonly inferenceResource?: LocalDocumentEmbeddingInferenceResource;
}

/** Offline-only production adapter backed by a verified Transformers.js ONNX model. */
export class TransformersJsLocalEmbeddingAdapter implements EmbeddingPort {
  readonly providerKind = "local" as const;
  readonly embeddingProfile: DocumentRetrievalEmbeddingProfile;
  readonly #artifactDirectory: string | undefined;
  readonly #profile: DocumentRetrievalEmbeddingProfile;
  readonly #runtimeFactory: LocalFeatureExtractionRuntimeFactory | undefined;
  #runtime: Promise<LocalFeatureExtractionRuntime> | undefined;

  constructor(options: TransformersJsLocalEmbeddingAdapterOptions) {
    const profile =
      options.profile ?? DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
    assertValidEmbeddingProfile(profile);
    if (profile.execution.kind !== "local") {
      throw new TypeError("local embedding adapter requires a local profile");
    }
    const hasDirectory = options.artifactDirectory !== undefined;
    const hasResource = options.inferenceResource !== undefined;
    if (hasDirectory === hasResource) {
      throw new TypeError(
        "local embedding adapter requires exactly one inference resource source",
      );
    }
    if (
      options.runtimeFactory !== undefined &&
      options.artifactDirectory === undefined
    ) {
      throw new TypeError(
        "a local embedding runtime factory requires an artifact directory",
      );
    }
    if (
      options.artifactDirectory !== undefined &&
      !isAbsolute(options.artifactDirectory)
    ) {
      throw new TypeError("embedding artifact directory must be absolute");
    }
    this.embeddingProfile = freezeDocumentProfile(profile);
    this.#profile = this.embeddingProfile;
    this.#artifactDirectory = options.artifactDirectory;
    this.#runtimeFactory = hasDirectory
      ? (options.runtimeFactory ?? new TransformersCompatibleOnnxRuntimeFactory())
      : undefined;
    if (options.inferenceResource !== undefined) {
      assertMatchingInferenceResource(
        options.inferenceResource,
        profile.execution,
      );
      this.#runtime = Promise.resolve(options.inferenceResource);
    }
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
        count = await withAbort(
          Promise.resolve(runtime.tokenCount(input.text)),
          request.signal,
        );
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
    if (
      this.#artifactDirectory === undefined ||
      this.#runtimeFactory === undefined
    ) {
      throw new EmbeddingProviderFault("provider_unavailable", false);
    }
    return loadLocalDocumentEmbeddingInferenceResource({
      artifactDirectory: this.#artifactDirectory,
      profile: this.#profile,
      runtimeFactory: this.#runtimeFactory,
    });
  }
}

/**
 * Loads one verified physical local inference resource for a composition root.
 *
 * The returned object is not an `EmbeddingPort`. A daemon may inject it into
 * independently owned document and Card adapters when their execution records
 * match, while each adapter still owns input transforms, profile checks, vector
 * validation and domain fault meanings.
 */
export async function loadLocalDocumentEmbeddingInferenceResource(options: {
  readonly artifactDirectory: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
  readonly runtimeFactory?: LocalFeatureExtractionRuntimeFactory;
}): Promise<LocalDocumentEmbeddingInferenceResource> {
  const { artifactDirectory, profile } = options;
  assertValidEmbeddingProfile(profile);
  if (profile.execution.kind !== "local" || !isAbsolute(artifactDirectory)) {
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  try {
    await verifyLocalEmbeddingAssets(artifactDirectory, profile);
  } catch (error) {
    if (error instanceof EmbeddingProviderFault) throw error;
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  try {
    const resource = await (
      options.runtimeFactory ?? new TransformersCompatibleOnnxRuntimeFactory()
    ).load({
      artifactDirectory,
      execution: profile.execution,
      modelMaxTokens: profile.modelMaxTokens,
    });
    assertMatchingInferenceResource(resource, profile.execution);
    return resource;
  } catch (error) {
    if (error instanceof EmbeddingProviderFault) throw error;
    throw new EmbeddingProviderFault("provider_unavailable", false);
  }
}

export async function verifyLocalEmbeddingAssets(
  artifactDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): Promise<LocalEmbeddingAssetManifest> {
  return verifyLocalEmbeddingAssetSet(artifactDirectory, profile, true);
}

/**
 * Verifies the pinned manifest and every asset's path and byte length without
 * hashing the model payload. Runtime startup still uses the full verifier;
 * routine status surfaces use this bounded-I/O form and reserve content hashes
 * for an explicit deep diagnosis.
 */
export async function verifyLocalEmbeddingAssetLayout(
  artifactDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): Promise<LocalEmbeddingAssetManifest> {
  return verifyLocalEmbeddingAssetSet(artifactDirectory, profile, false);
}

async function verifyLocalEmbeddingAssetSet(
  artifactDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
  verifyContent: boolean,
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
      await verifyAssetFile(root, file, verifyContent);
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

/**
 * Reproduces the text feature-extraction semantics pinned by adapterVersion
 * 4.2.0 without installing the unused browser and image runtimes pulled in by
 * the full Transformers.js package. The tokenizer implementation is the same
 * package used by Transformers.js 4.2.0, and the ONNX model path is already
 * pinned and content-verified by the asset manifest.
 */
class TransformersCompatibleOnnxRuntimeFactory
  implements LocalFeatureExtractionRuntimeFactory
{
  async load(input: {
    readonly artifactDirectory: string;
    readonly execution: LocalDocumentEmbeddingExecution;
    readonly modelMaxTokens: number;
  }): Promise<LocalFeatureExtractionRuntime> {
    const [tokenizerDefinition, tokenizerConfig] = await Promise.all([
      readJsonObject(resolve(input.artifactDirectory, "tokenizer.json")),
      readJsonObject(resolve(input.artifactDirectory, "tokenizer_config.json")),
    ]);
    const tokenizer = new Tokenizer(tokenizerDefinition, tokenizerConfig);
    const padding = readTokenizerPadding(tokenizerDefinition);
    // ORT 1.29 enables platform telemetry bookkeeping by default. Disable it
    // unless the host explicitly opted in: on macOS its fallback otherwise
    // writes a `:memory:.ses` identifier into the process working directory.
    process.env.ORT_DISABLE_TELEMETRY ??= "1";
    // Keep non-actionable runtime warnings out of CLI stderr while preserving
    // real inference errors.
    onnx.env.logLevel = "error";
    const session = await onnx.InferenceSession.create(
      resolve(input.artifactDirectory, input.execution.artifactPath),
      {
        executionProviders: ["cpu"],
        logSeverityLevel: 3,
      },
    );
    assertSupportedOnnxInterface(session);
    return {
      execution: Object.freeze({ ...input.execution }),
      modelMaxTokens: input.modelMaxTokens,
      tokenCount: (text) => tokenizer.encode(text).ids.length,
      embed: async (texts, options) => {
        const batch = tokenizeBatch(tokenizer, texts, padding);
        const feeds = createOnnxFeeds(session.inputNames, batch);
        try {
          const outputs = await session.run(feeds);
          try {
            const tensor = selectEmbeddingTensor(outputs);
            return poolAndNormalizeTensor(tensor, batch, options.pooling);
          } finally {
            disposeTensors(Object.values(outputs));
          }
        } finally {
          disposeTensors(Object.values(feeds));
        }
      },
    };
  }
}

interface TokenizerPadding {
  readonly id: number;
  readonly typeId: number;
}

interface TokenizedBatch {
  readonly batchSize: number;
  readonly sequenceLength: number;
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly tokenTypeIds: BigInt64Array;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`expected a JSON object at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function readTokenizerPadding(
  definition: Record<string, unknown>,
): TokenizerPadding {
  const padding = definition.padding;
  if (padding === null || typeof padding !== "object" || Array.isArray(padding)) {
    throw new TypeError("tokenizer definition requires padding metadata");
  }
  const values = padding as Record<string, unknown>;
  const id = values.pad_id;
  const typeId = values.pad_type_id;
  if (
    !Number.isSafeInteger(id) ||
    (id as number) < 0 ||
    !Number.isSafeInteger(typeId) ||
    (typeId as number) < 0
  ) {
    throw new TypeError("tokenizer padding ids must be non-negative integers");
  }
  return { id: id as number, typeId: typeId as number };
}

function assertSupportedOnnxInterface(session: onnx.InferenceSession): void {
  const inputs = new Set(session.inputNames);
  const outputs = new Set(session.outputNames);
  const supportedInputs = new Set([
    "input_ids",
    "attention_mask",
    "token_type_ids",
  ]);
  if (
    !inputs.has("input_ids") ||
    !inputs.has("attention_mask") ||
    session.inputNames.some((name) => !supportedInputs.has(name)) ||
    !["last_hidden_state", "logits", "token_embeddings"].some((name) =>
      outputs.has(name),
    )
  ) {
    void session.release();
    throw new TypeError("unsupported local embedding ONNX interface");
  }
}

function tokenizeBatch(
  tokenizer: Tokenizer,
  texts: readonly string[],
  padding: TokenizerPadding,
): TokenizedBatch {
  const encodings = texts.map((text) => tokenizer.encode(text));
  const sequenceLength = Math.max(...encodings.map((item) => item.ids.length));
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength <= 0) {
    throw new TypeError("tokenizer produced an empty batch");
  }
  const inputIds = new BigInt64Array(texts.length * sequenceLength);
  const attentionMask = new BigInt64Array(texts.length * sequenceLength);
  const tokenTypeIds = new BigInt64Array(texts.length * sequenceLength);
  inputIds.fill(BigInt(padding.id));
  tokenTypeIds.fill(BigInt(padding.typeId));
  encodings.forEach((encoding, batchIndex) => {
    writeEncoding(
      encoding,
      batchIndex * sequenceLength,
      inputIds,
      attentionMask,
      tokenTypeIds,
    );
  });
  return {
    batchSize: texts.length,
    sequenceLength,
    inputIds,
    attentionMask,
    tokenTypeIds,
  };
}

function writeEncoding(
  encoding: Encoding,
  offset: number,
  inputIds: BigInt64Array,
  attentionMask: BigInt64Array,
  tokenTypeIds: BigInt64Array,
): void {
  encoding.ids.forEach((id: number, index: number) => {
    inputIds[offset + index] = BigInt(id);
    attentionMask[offset + index] = BigInt(
      encoding.attention_mask[index] ?? 1,
    );
    tokenTypeIds[offset + index] = BigInt(
      encoding.token_type_ids?.[index] ?? 0,
    );
  });
}

function createOnnxFeeds(
  inputNames: readonly string[],
  batch: TokenizedBatch,
): Record<string, onnx.Tensor> {
  const dimensions = [batch.batchSize, batch.sequenceLength];
  const values: Record<string, BigInt64Array> = {
    input_ids: batch.inputIds,
    attention_mask: batch.attentionMask,
    token_type_ids: batch.tokenTypeIds,
  };
  return Object.fromEntries(
    inputNames.map((name) => [
      name,
      new onnx.Tensor("int64", values[name]!, dimensions),
    ]),
  );
}

function selectEmbeddingTensor(
  outputs: onnx.InferenceSession.OnnxValueMapType,
): onnx.Tensor {
  const tensor =
    outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings;
  if (!(tensor instanceof onnx.Tensor)) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  return tensor;
}

function disposeTensors(values: readonly onnx.Tensor[]): void {
  for (const tensor of values) tensor.dispose();
}

function poolAndNormalizeTensor(
  tensor: onnx.Tensor,
  batch: TokenizedBatch,
  pooling: "cls" | "mean",
): { readonly dimensions: readonly number[]; readonly data: Float32Array } {
  const dimensions = tensor.dims;
  const data = tensor.data;
  if (
    dimensions.length !== 3 ||
    dimensions[0] !== batch.batchSize ||
    dimensions[1] !== batch.sequenceLength ||
    !(data instanceof Float32Array)
  ) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  const width = dimensions[2]!;
  const pooled = new Float32Array(batch.batchSize * width);
  for (let batchIndex = 0; batchIndex < batch.batchSize; batchIndex += 1) {
    for (let component = 0; component < width; component += 1) {
      pooled[batchIndex * width + component] =
        pooling === "cls"
          ? data[batchIndex * batch.sequenceLength * width + component]!
          : meanPooledComponent(data, batch, batchIndex, component, width);
    }
  }
  normalizeFloat32Rows(pooled, batch.batchSize, width);
  return { dimensions: [batch.batchSize, width], data: pooled };
}

function meanPooledComponent(
  data: Float32Array,
  batch: TokenizedBatch,
  batchIndex: number,
  component: number,
  width: number,
): number {
  let sum = 0;
  let count = 0;
  for (let tokenIndex = 0; tokenIndex < batch.sequenceLength; tokenIndex += 1) {
    const mask = Number(
      batch.attentionMask[batchIndex * batch.sequenceLength + tokenIndex],
    );
    count += mask;
    sum +=
      data[
        (batchIndex * batch.sequenceLength + tokenIndex) * width + component
      ]! * mask;
  }
  if (count === 0) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  return sum / count;
}

/** Matches Transformers.js 4.2.0 Float32 accumulation and assignment. */
function normalizeFloat32Rows(
  values: Float32Array,
  rows: number,
  width: number,
): void {
  const norms = new Float32Array(rows);
  for (let index = 0; index < values.length; index += 1) {
    const row = Math.floor(index / width);
    norms[row] = norms[row]! + values[index]! ** 2;
  }
  for (let row = 0; row < rows; row += 1) {
    norms[row] = Math.sqrt(norms[row]!);
    if (!Number.isFinite(norms[row]) || norms[row] === 0) {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
  }
  for (let index = 0; index < values.length; index += 1) {
    values[index] = values[index]! / norms[Math.floor(index / width)]!;
  }
}

function assertMatchingInferenceResource(
  resource: LocalDocumentEmbeddingInferenceResource,
  execution: LocalDocumentEmbeddingExecution,
): void {
  if (
    typeof resource.tokenCount !== "function" ||
    typeof resource.embed !== "function" ||
    !Number.isSafeInteger(resource.modelMaxTokens) ||
    resource.modelMaxTokens <= 0 ||
    canonicalJson(resource.execution) !== canonicalJson(execution)
  ) {
    throw new TypeError(
      "local embedding inference resource does not match the configured execution",
    );
  }
}

function freezeDocumentProfile(
  profile: DocumentRetrievalEmbeddingProfile,
): DocumentRetrievalEmbeddingProfile {
  return Object.freeze({
    ...structuredClone(profile),
    execution: Object.freeze({ ...profile.execution }),
    admissionLimit: Object.freeze({ ...profile.admissionLimit }),
  });
}

function outputsFromTensor(
  request: EmbeddingProviderRequest,
  tensor: {
    readonly dimensions: readonly number[];
    readonly data: readonly number[] | Float32Array;
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
  const data = Array.isArray(tensor.data)
    ? tensor.data
    : Array.from(tensor.data, Number);
  return request.inputs.map((input, index) => {
    const vector = data.slice(index * dimensions, (index + 1) * dimensions);
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
  verifyContent: boolean,
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
    if (!verifyContent) return;
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

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

/** Shared with the installer so both sides apply one traversal rule. */
export function isSafeRelativePath(value: unknown): value is string {
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
