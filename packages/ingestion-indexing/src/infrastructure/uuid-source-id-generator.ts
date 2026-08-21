import type { SourceRootIdGenerator } from "../ports/source-adapter.js";
import {
  UuidV7RootIdGenerator,
  type UuidV7RootIdGeneratorOptions,
} from "./uuid-v7-root-id-generator.js";

export type UuidSourceIdGeneratorOptions = UuidV7RootIdGeneratorOptions;

/** Collision-resistant Source identity generator for durable compositions. */
export class UuidSourceIdGenerator implements SourceRootIdGenerator {
  readonly #ids: UuidV7RootIdGenerator;

  constructor(options: UuidSourceIdGeneratorOptions = {}) {
    this.#ids = new UuidV7RootIdGenerator(options);
  }

  nextSourceId(): string {
    return this.#ids.nextSourceId();
  }

  nextObservationId(): string {
    return this.#ids.nextObservationId();
  }
}
