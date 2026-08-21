import { z } from "zod";

// Stable identities name logical objects; revision identities pin immutable
// representations of those objects at a particular processing boundary.
function identifier(prefix: string) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$`),
      `expected ${prefix}_ identifier`,
    );
}

const UUID_V7_BODY =
  "[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";

function uuidV7Identifier(prefix: string) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_${UUID_V7_BODY}$`),
      `expected ${prefix}_ identifier with UUIDv7 body`,
    );
}

function revision(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[a-z2-7]+$`), `expected ${prefix}_ revision`);
}

export const SourceIdSchema = uuidV7Identifier("src");
export const ObservationIdSchema = uuidV7Identifier("obs");
export const PublicationIdSchema = uuidV7Identifier("pub");
export const DocumentIdSchema = uuidV7Identifier("doc");
export const DocumentIndexIdSchema = identifier("didx");
export const KnowledgeUnitIdSchema = identifier("unit");
export const SemanticUnitIdSchema = identifier("unit");
export const PublicationScopeIdSchema = identifier("scope");
export const IndexVersionSchema = revision("idxv");
export const PublicationScopeVersionSchema = revision("scpv");

/** Digest used to compare canonical content without exposing that content. */
export const ContentDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected sha256 digest");

/** Logical adapter identity resolved by the daemon, never a credential. */
export const ConnectorIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
    "expected lowercase connector identifier",
  );
export const CanonicalTimestampSchema = z.iso.datetime({
  offset: false,
  local: false,
  precision: 3,
});

export type SourceId = z.infer<typeof SourceIdSchema>;
export type ObservationId = z.infer<typeof ObservationIdSchema>;
export type PublicationId = z.infer<typeof PublicationIdSchema>;
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type DocumentIndexId = z.infer<typeof DocumentIndexIdSchema>;
export type KnowledgeUnitId = z.infer<typeof KnowledgeUnitIdSchema>;
export type SemanticUnitId = z.infer<typeof SemanticUnitIdSchema>;
export type PublicationScopeId = z.infer<typeof PublicationScopeIdSchema>;
export type IndexVersion = z.infer<typeof IndexVersionSchema>;
export type PublicationScopeVersion = z.infer<
  typeof PublicationScopeVersionSchema
>;
export type ContentDigest = z.infer<typeof ContentDigestSchema>;
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;
