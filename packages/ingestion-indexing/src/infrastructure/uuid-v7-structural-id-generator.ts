import type { BlockIdSource } from "../domain/document-capture.js";
import type { SemanticUnitIdSource } from "../domain/document-segmentation.js";
import type { ManagedChunkIdSource } from "../domain/managed-chunk-generation.js";
import { UuidV7Generator, type UuidV7Options } from "./uuid-v7.js";

export type UuidV7StructuralIdGeneratorOptions = UuidV7Options;

export interface StructuralIdGenerator
  extends BlockIdSource,
    SemanticUnitIdSource,
    ManagedChunkIdSource {}

/** Issues every persisted document-structure identity from one UUIDv7 source. */
export class UuidV7StructuralIdGenerator implements StructuralIdGenerator {
  readonly #uuids: UuidV7Generator;

  constructor(options: UuidV7StructuralIdGeneratorOptions = {}) {
    this.#uuids = new UuidV7Generator(options);
  }

  nextBlockId(): string {
    return `blk_${this.#uuids.nextUuid()}`;
  }

  nextUnitId(): string {
    return `unit_${this.#uuids.nextUuid()}`;
  }

  nextChunkId(): string {
    return `chk_${this.#uuids.nextUuid()}`;
  }
}
