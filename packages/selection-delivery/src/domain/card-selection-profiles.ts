import {
  DEFAULT_CARD_ADMISSION_LIMITS,
  type CardSelectionEmbeddingProfile,
  type CardSelectionProfile,
} from "./card-selection-profile.js";

/**
 * The Card vector families this domain ships, as values.
 *
 * Declared here and not in the Composition Root because the profile is the
 * selection policy's own: which model a Card is embedded under, at what
 * precision and width, is a quality decision Selection owns and the daemon
 * assembles (개발 파트 분담 §3 "Card 선택용 Card·query embedding profile";
 * SOT L1374-L1378). What stays in the daemon is the binding — which provider
 * instance serves a profile, and whether it shares a session with the document
 * path — which is composition and not policy.
 *
 * `card-selection-profile.ts` holds the shape and its validators; this file
 * holds the instances. Kept apart so that the artifact digests pinned below
 * never sit beside the code that checks profiles in general.
 */

/**
 * The Card vector family a production deployment selects under.
 *
 * It names the same repository, the same revision, the same file and the same
 * digest as `DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE`, and that is
 * deliberate: document retrieval moved to fp32, and making an operator install a
 * second 390MB model whose only difference is quantization would buy nothing.
 * One artifact on disk, one loaded session, two profiles.
 *
 * The ids differ, and that is what keeps them two families rather than one. A
 * Card vector and a document chunk vector are built from different text, rebuilt
 * on different events and held in different indexes; sharing an id would make
 * "same weights" read as "same vector space", and a Card would become
 * comparable against a document index by accident.
 */
export const CARD_SELECTION_EMBEDDING_PROFILE: CardSelectionEmbeddingProfile =
  Object.freeze({
    id: "card-granite-97m-multilingual-r2-fp32-v2",
    version: "2",
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
      // The digest of the installed asset manifest, restated as a literal.
      // Ingestion owns the artifact specification and exports this value as
      // `DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256`, but this package may
      // not import another domain package (package-boundaries test, ADR 0004's
      // ownership rule), so the value is copied rather than referenced. The
      // daemon — the one place that sees both packages — holds the test that
      // fails the build the day the two drift apart.
      assetManifestSha256:
        "eb0923125496145fce8105135180b42f37d098c688837037d73e4ba11bd8c389",
      precision: "fp32",
    }),
    dimensions: 384,
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
    selectionTextSchemaVersion: 3,
    cardInputTransformVersion: "card-selection-text-v3",
    queryInputTransformVersion: "card-selection-text-v3",
    admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
  });

/**
 * The Card vector family a network-free composition selects under.
 *
 * It carries no `execution` block, which is what makes it a legal profile for a
 * provider that loads nothing: a profile that pinned an artifact while a hash
 * adapter produced the vectors would state a provenance that is simply false.
 * Eight dimensions rather than 384 for the same reason `DEFAULT_EMBEDDING_PROFILE`
 * is eight — nothing in a hash vector needs the width.
 */
export const DETERMINISTIC_CARD_SELECTION_PROFILE: CardSelectionProfile =
  Object.freeze({
    id: "card-deterministic-local-v2",
    version: "2",
    model: "deterministic-local-v1",
    dimensions: 8,
    distance: "cosine",
    normalization: "l2",
    selectionTextSchemaVersion: 3,
    admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
  });
