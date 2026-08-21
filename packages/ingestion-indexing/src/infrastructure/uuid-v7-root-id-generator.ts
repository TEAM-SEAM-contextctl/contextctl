import type { PublicationRootIdGenerator } from "../ports/markdown-publication.js";
import type { SourceRootIdGenerator } from "../ports/source-adapter.js";
import { UuidV7Generator, type UuidV7Options } from "./uuid-v7.js";

export type UuidV7RootIdGeneratorOptions = UuidV7Options;

/** Issues every persisted Ingestion root identity from one UUIDv7 source. */
export class UuidV7RootIdGenerator
  implements SourceRootIdGenerator, PublicationRootIdGenerator
{
  readonly #uuids: UuidV7Generator;

  constructor(options: UuidV7RootIdGeneratorOptions = {}) {
    this.#uuids = new UuidV7Generator(options);
  }

  nextSourceId(): string {
    return `src_${this.#uuids.nextUuid()}`;
  }

  nextDocumentId(): string {
    return `doc_${this.#uuids.nextUuid()}`;
  }

  nextObservationId(): string {
    return `obs_${this.#uuids.nextUuid()}`;
  }

  nextPublicationId(): string {
    return `pub_${this.#uuids.nextUuid()}`;
  }
}
