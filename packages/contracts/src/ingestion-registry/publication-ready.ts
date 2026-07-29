import { z } from "zod";

import { parseContract } from "../contract-validation.js";
import { PublicationIdSchema } from "../identifiers.js";

const ContractSchemaVersion = z.literal(1);

/**
 * Lightweight notification that announces a durable publication by identity;
 * Registry fetches and validates the publication through its configured port.
 */
export const PublicationReadySchema = z
  .object({
    schemaVersion: ContractSchemaVersion,
    publicationId: PublicationIdSchema,
  })
  .strict();

export type PublicationReady = z.infer<typeof PublicationReadySchema>;

/** Parses an ID-only publication notification without accepting extra fields. */
export function parsePublicationReady(input: unknown): PublicationReady {
  return parseContract("PublicationReady", PublicationReadySchema, input);
}
