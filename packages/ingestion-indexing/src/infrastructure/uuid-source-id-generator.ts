import { randomUUID } from "node:crypto";

import type { SourceIdGenerator } from "../ports/source-adapter.js";

export interface UuidSourceIdGeneratorOptions {
  readonly randomUuid?: () => string;
}

/** Collision-resistant Source identity generator for durable compositions. */
export class UuidSourceIdGenerator implements SourceIdGenerator {
  readonly #randomUuid: () => string;

  constructor(options: UuidSourceIdGeneratorOptions = {}) {
    this.#randomUuid = options.randomUuid ?? randomUUID;
  }

  nextSourceId(): string {
    const value = this.#randomUuid().toLowerCase();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
      throw new TypeError("UUID Source ID generator returned an invalid UUID");
    }
    return `src_${value}`;
  }
}
