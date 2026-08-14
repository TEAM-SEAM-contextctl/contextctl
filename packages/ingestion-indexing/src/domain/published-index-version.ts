import {
  PublishedDocumentIndexRefSchema,
  PublishedDocumentScopeSchema,
  type PublishedDocumentIndexRef,
  type PublishedDocumentScope,
} from "@contextctl/contracts";

import { validateEmbeddingProfile } from "./embedding-profile.js";
import type { IndexManifest, ScopeRevision } from "./index-manifest.js";
import {
  isDigest,
  isId,
  isIsoTimestamp,
  isRevisionId,
} from "./model-validation.js";
import { canonicalDigest, canonicalJson } from "./revision-identity.js";

/** Immutable catalog record made visible by one atomic current transition. */
export interface PublishedIndexVersion {
  readonly manifest: IndexManifest;
  /** Internal isolation key; never serialized into a Published Scope. */
  readonly securityDomain: string;
  readonly documentIndex: PublishedDocumentIndexRef;
  readonly scopes: readonly PublishedDocumentScope[];
}

export type PublishedIndexVersionValidationErrorCode =
  | "corrupt_record"
  | "schema_unsupported";

export class PublishedIndexVersionValidationError extends Error {
  constructor(readonly code: PublishedIndexVersionValidationErrorCode) {
    super(`Published Index version is invalid: ${code}`);
    this.name = "PublishedIndexVersionValidationError";
  }
}

/** Validates untrusted durable catalog data before it reaches search. */
export function parsePublishedIndexVersion(
  input: unknown,
): PublishedIndexVersion {
  if (!isRecord(input) || !hasExactKeys(input, PUBLICATION_KEYS)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  const manifest = parseManifest(input.manifest);
  const documentIndex = PublishedDocumentIndexRefSchema.safeParse(
    input.documentIndex,
  );
  if (!documentIndex.success || !Array.isArray(input.scopes)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  const scopes = input.scopes.map((scope) => {
    const parsed = PublishedDocumentScopeSchema.safeParse(scope);
    if (!parsed.success) {
      throw new PublishedIndexVersionValidationError("corrupt_record");
    }
    return parsed.data;
  });
  if (typeof input.securityDomain !== "string") {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  const publication: PublishedIndexVersion = {
    manifest,
    securityDomain: input.securityDomain,
    documentIndex: documentIndex.data,
    scopes,
  };
  assertConsistentPublishedIndexVersion(publication);
  return publication;
}

export function assertConsistentPublishedIndexVersion(
  publication: PublishedIndexVersion,
): void {
  const { manifest, documentIndex, scopes } = publication;
  if (
    publication.securityDomain.trim() === "" ||
    documentIndex.documentIndexId !== manifest.documentIndexId ||
    documentIndex.sourceId !== manifest.sourceId ||
    documentIndex.documentId !== manifest.documentId ||
    documentIndex.indexVersion !== manifest.indexVersion ||
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        canonicalJson(scope.documentIndex) !== canonicalJson(documentIndex),
    ) ||
    canonicalJson(
      scopes.map(({ scopeId, scopeVersion }) => ({ scopeId, scopeVersion })),
    ) !== canonicalJson(manifest.scopeRevisions)
  ) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
}

export function publishedIndexVersionFingerprint(
  publication: PublishedIndexVersion,
): string {
  const { publishedAt: _publishedAt, ...manifest } = publication.manifest;
  return canonicalDigest({
    manifest,
    securityDomain: publication.securityDomain,
    documentIndex: publication.documentIndex,
    scopes: publication.scopes,
  });
}

const PUBLICATION_KEYS = [
  "documentIndex",
  "manifest",
  "scopes",
  "securityDomain",
] as const;

const MANIFEST_KEYS = [
  "chunkPolicyVersion",
  "chunkRevisions",
  "documentId",
  "documentIndexId",
  "documentSchemaVersion",
  "embeddingProfile",
  "fallbackCounts",
  "indexVersion",
  "lineagePolicyVersion",
  "normalizationPolicyVersion",
  "observationId",
  "parserVersion",
  "payloadSchemaVersion",
  "publishedAt",
  "recordCount",
  "recordSetDigest",
  "scopeRevisions",
  "segmentationPolicyVersion",
  "semanticUnitRevisions",
  "sourceId",
  "textMeasureProfileVersion",
] as const;

function parseManifest(input: unknown): IndexManifest {
  if (!isRecord(input)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  if (
    typeof input.payloadSchemaVersion === "number" &&
    input.payloadSchemaVersion !== 2
  ) {
    throw new PublishedIndexVersionValidationError("schema_unsupported");
  }
  if (!hasExactKeys(input, MANIFEST_KEYS)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  const embeddingProfile = parseEmbeddingProfile(input.embeddingProfile);
  const scopeRevisions = parseScopeRevisions(input.scopeRevisions);
  const semanticUnitRevisions = parseRevisionRecord(
    input.semanticUnitRevisions,
    "unit",
    "urv",
  );
  const chunkRevisions = parseRevisionRecord(
    input.chunkRevisions,
    "chk",
    "crv",
  );
  const fallbackCounts = parseNumberRecord(input.fallbackCounts);
  const documentIndexId = requiredString(input.documentIndexId);
  const indexVersion = requiredString(input.indexVersion);
  const sourceId = requiredString(input.sourceId);
  const observationId = requiredString(input.observationId);
  const documentId = requiredString(input.documentId);
  const parserVersion = requiredString(input.parserVersion);
  const normalizationPolicyVersion = requiredString(
    input.normalizationPolicyVersion,
  );
  const lineagePolicyVersion = requiredString(input.lineagePolicyVersion);
  const segmentationPolicyVersion = requiredString(
    input.segmentationPolicyVersion,
  );
  const chunkPolicyVersion = requiredString(input.chunkPolicyVersion);
  const textMeasureProfileVersion = requiredString(
    input.textMeasureProfileVersion,
  );
  const recordSetDigest = requiredString(input.recordSetDigest);
  const publishedAt = requiredString(input.publishedAt);
  const recordCount = input.recordCount;
  if (
    input.payloadSchemaVersion !== 2 ||
    !isId(documentIndexId, "didx") ||
    !isRevisionId(indexVersion, "idxv") ||
    !isId(sourceId, "src") ||
    !isId(observationId, "obs") ||
    !isId(documentId, "doc") ||
    !isPositiveInteger(input.documentSchemaVersion) ||
    !isNonNegativeInteger(recordCount) ||
    recordCount !== Object.keys(chunkRevisions).length ||
    Object.keys(semanticUnitRevisions).length === 0 ||
    !isDigest(recordSetDigest) ||
    !isIsoTimestamp(publishedAt) ||
    embeddingProfile.textMeasureProfileVersion !==
      textMeasureProfileVersion
  ) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  return {
    documentIndexId,
    indexVersion,
    sourceId,
    observationId,
    documentId,
    documentSchemaVersion: input.documentSchemaVersion,
    parserVersion,
    normalizationPolicyVersion,
    lineagePolicyVersion,
    segmentationPolicyVersion,
    chunkPolicyVersion,
    textMeasureProfileVersion,
    embeddingProfile,
    payloadSchemaVersion: 2,
    semanticUnitRevisions,
    chunkRevisions,
    recordCount,
    recordSetDigest,
    scopeRevisions,
    fallbackCounts,
    publishedAt,
  };
}

function parseEmbeddingProfile(input: unknown): IndexManifest["embeddingProfile"] {
  if (!isRecord(input) || !hasExactKeys(input, EMBEDDING_PROFILE_KEYS)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  const profile = input as unknown as IndexManifest["embeddingProfile"];
  if (validateEmbeddingProfile(profile).length > 0) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  return structuredClone(profile);
}

function parseScopeRevisions(input: unknown): readonly ScopeRevision[] {
  if (!Array.isArray(input)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  return input.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["scopeId", "scopeVersion"] as const) ||
      !isNonEmptyString(candidate.scopeId) ||
      !isNonEmptyString(candidate.scopeVersion) ||
      !isId(candidate.scopeId, "scope") ||
      !isRevisionId(candidate.scopeVersion, "scpv")
    ) {
      throw new PublishedIndexVersionValidationError("corrupt_record");
    }
    return {
      scopeId: candidate.scopeId,
      scopeVersion: candidate.scopeVersion,
    };
  });
}

function parseRevisionRecord(
  input: unknown,
  identityPrefix: string,
  revisionPrefix: string,
): Readonly<Record<string, string>> {
  if (!isRecord(input)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  for (const [identity, revision] of Object.entries(input)) {
    if (
      !isNonEmptyString(revision) ||
      !isId(identity, identityPrefix) ||
      !isRevisionId(revision, revisionPrefix)
    ) {
      throw new PublishedIndexVersionValidationError("corrupt_record");
    }
  }
  return structuredClone(input) as Readonly<Record<string, string>>;
}

function parseNumberRecord(input: unknown): Readonly<Record<string, number>> {
  if (
    !isRecord(input) ||
    Object.entries(input).some(
      ([key, value]) =>
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(key) ||
        !Number.isSafeInteger(value) ||
        (value as number) < 0,
    )
  ) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  return structuredClone(input) as Readonly<Record<string, number>>;
}

function hasExactKeys(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return canonicalJson(Object.keys(input).sort()) === canonicalJson([...keys].sort());
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requiredString(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new PublishedIndexVersionValidationError("corrupt_record");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const EMBEDDING_PROFILE_KEYS = [
  "dimensions",
  "distance",
  "id",
  "maxInputTokens",
  "model",
  "textMeasureProfileVersion",
  "version",
] as const;
