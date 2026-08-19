import { CardSelectionProfileInvariantError } from "./errors.js";
import { canonicalJson } from "./canonical-digest.js";
import { TEXT_MEASURE_PROFILE_VERSION } from "./text-measure.js";

/**
 * The compatibility boundary for one family of Card vectors.
 *
 * Declared here rather than reused from Indexing's `EmbeddingProfile`, and that
 * is a decision rather than a duplication. A profile is what makes two vectors
 * comparable, and Card vectors and document chunk vectors are not comparable
 * even when they were produced by the same model file: they are built from
 * different text (a Card's declared meaning versus a chunk of a document), they
 * are rebuilt on different events (a Card Version approval versus a document
 * publication), and they live in different indexes. Sharing one profile type
 * would make "same model" read as "same vector space", which is the mistake that
 * lets a Card be scored against a document index by accident.
 *
 * A deployment may still run both families through one stateless inference
 * session over one installed artifact. That is a fact about the session, not
 * about the profiles.
 */

/**
 * The admission bound each side of a query is measured against.
 *
 * Two numbers rather than one, because the two inputs are not the same kind of
 * text: a Card's canonical selection text is a document about the Card and is
 * allowed to be long, while a query is something a person typed. The measure
 * profile is named alongside them so a limit is never a bare number whose unit
 * has to be guessed.
 */
export interface CardAdmissionLimits {
  readonly textMeasureProfileVersion: typeof TEXT_MEASURE_PROFILE_VERSION;
  readonly maxCardUnits: 2048;
  readonly maxQueryUnits: 480;
}

/** The admission bound every Card profile in this repository carries. */
export const DEFAULT_CARD_ADMISSION_LIMITS: CardAdmissionLimits = Object.freeze({
  textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
  maxCardUnits: 2048,
  maxQueryUnits: 480,
});

/**
 * What identifies one Card vector family, with nothing about how it is produced.
 *
 * The split mirrors Indexing's own `EmbeddingProfile` /
 * `DocumentRetrievalEmbeddingProfile` pair, and for the same reason: a test
 * composition binds a network-free provider and has no artifact to describe, so
 * a profile that required an `execution` block would force such a composition to
 * state a repository, a revision and a digest that describe nothing. Everything
 * a candidate index needs in order to refuse an incompatible vector is here;
 * `execution` is what a *production* deployment additionally pins.
 */
export interface CardSelectionProfile {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly dimensions: number;
  readonly distance: "cosine";
  readonly normalization: "l2";
  readonly selectionTextSchemaVersion: 2;
  readonly admissionLimits: CardAdmissionLimits;
}

/** A model file on this machine, pinned by digest. Never downloaded at runtime. */
export interface LocalCardEmbeddingExecution {
  readonly kind: "local";
  readonly adapter: "transformers-js-onnx";
  readonly adapterVersion: string;
  readonly artifactRepository: string;
  readonly artifactRevision: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly assetManifestSha256: string;
  /**
   * `fp32` is present alongside `q8` because the installed artifact is the fp32
   * one: document retrieval moved to fp32 and the Card layer follows it onto the
   * same file rather than making an operator install a second 390MB model whose
   * only difference is quantization. The two ids still differ, so the two
   * families remain separately versionable.
   */
  readonly precision: "q8" | "fp32";
}

/** A provider reached over the network. No binding for one exists here yet. */
export interface RemoteCardEmbeddingExecution {
  readonly kind: "remote";
  readonly adapter: "openai-compatible";
  readonly adapterVersion: string;
  readonly model: string;
}

export type CardEmbeddingExecution =
  | LocalCardEmbeddingExecution
  | RemoteCardEmbeddingExecution;

/**
 * A Card vector family that also states exactly how its vectors were produced.
 *
 * Every field on `execution` is part of the identity of the vectors: a different
 * artifact digest, a different precision or a different adapter version can move
 * a cosine, so two indexes built under two of these are not comparable even
 * when the ids match.
 */
export interface CardSelectionEmbeddingProfile extends CardSelectionProfile {
  readonly modelRevision: string;
  readonly execution: CardEmbeddingExecution;
  readonly pooling: "cls" | "mean" | "provider_defined";
  readonly cardInputTransformVersion: string;
  readonly queryInputTransformVersion: string;
}

/** Whether this profile pins an artifact, and is therefore a production one. */
export function isCardSelectionEmbeddingProfile(
  profile: CardSelectionProfile,
): profile is CardSelectionEmbeddingProfile {
  return (
    (profile as Partial<CardSelectionEmbeddingProfile>).execution !== undefined
  );
}

/**
 * Whether two profiles describe the same vector space, field for field.
 *
 * Canonical JSON rather than an id comparison: an id is a name someone chose,
 * and two profiles that share a name while differing in `dimensions` or
 * `precision` describe two spaces. Comparing the whole record is what makes a
 * silent edit to a profile constant show up as an incompatible index instead of
 * as a quietly wrong ranking.
 */
export function cardSelectionProfilesMatch(
  left: CardSelectionProfile,
  right: CardSelectionProfile,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Refuses a profile whose own fields contradict each other.
 *
 * Checked where the profile is bound rather than where a vector is compared, so
 * an unusable profile ends the assembly instead of producing an index nothing
 * can be scored against.
 */
export function assertValidCardSelectionProfile(
  profile: CardSelectionProfile,
): void {
  if (profile.id.trim() === "" || profile.version.trim() === "") {
    throw new CardSelectionProfileInvariantError(
      "a Card selection profile must carry a non-empty id and version",
    );
  }
  if (!Number.isSafeInteger(profile.dimensions) || profile.dimensions <= 0) {
    throw new CardSelectionProfileInvariantError(
      `Card embedding dimensions must be a positive integer, received ${String(profile.dimensions)}`,
    );
  }
  const limits = profile.admissionLimits;
  if (
    !Number.isSafeInteger(limits.maxCardUnits) ||
    limits.maxCardUnits <= 0 ||
    !Number.isSafeInteger(limits.maxQueryUnits) ||
    limits.maxQueryUnits <= 0
  ) {
    throw new CardSelectionProfileInvariantError(
      "Card admission limits must be positive integers",
    );
  }
  if (limits.textMeasureProfileVersion !== TEXT_MEASURE_PROFILE_VERSION) {
    throw new CardSelectionProfileInvariantError(
      `Card admission limits are stated under ${limits.textMeasureProfileVersion}, which this package cannot measure`,
    );
  }
  if (
    isCardSelectionEmbeddingProfile(profile) &&
    profile.pooling === "provider_defined" &&
    profile.execution.kind === "local"
  ) {
    // A local ONNX session has no pooling of its own to defer to: the adapter
    // has to be told which row of the last hidden state is the sentence.
    throw new CardSelectionProfileInvariantError(
      "a local Card embedding profile must state cls or mean pooling",
    );
  }
}
