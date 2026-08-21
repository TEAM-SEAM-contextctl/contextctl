import type { BlockIdSource } from "../domain/document-capture.js";
import { UuidV7Generator, type UuidV7Options } from "./uuid-v7.js";

export type UuidV7BlockIdSourceOptions = UuidV7Options;

export class UuidV7BlockIdSource implements BlockIdSource {
  readonly #uuids: UuidV7Generator;

  constructor(options: UuidV7BlockIdSourceOptions = {}) {
    this.#uuids = new UuidV7Generator(options);
  }

  nextBlockId(): string {
    return `blk_${this.#uuids.nextUuid()}`;
  }
}
