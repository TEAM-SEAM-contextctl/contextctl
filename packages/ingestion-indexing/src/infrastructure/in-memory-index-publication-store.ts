import { canonicalJson } from "../domain/revision-identity.js";
import {
  IndexPublicationStoreConflict,
  type CommitIndexPublicationResult,
  type IndexPublicationStore,
  type PublishedIndexVersion,
} from "../ports/index-publication-store.js";

export class InMemoryIndexPublicationStore implements IndexPublicationStore {
  readonly #versions = new Map<string, PublishedIndexVersion>();
  readonly #current = new Map<string, string>();

  async findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<PublishedIndexVersion | undefined> {
    return clone(this.#versions.get(versionKey(input)));
  }

  async current(
    documentIndexId: string,
  ): Promise<PublishedIndexVersion | undefined> {
    const indexVersion = this.#current.get(documentIndexId);
    return indexVersion === undefined
      ? undefined
      : clone(this.#versions.get(versionKey({ documentIndexId, indexVersion })));
  }

  async commitCurrent(
    publication: PublishedIndexVersion,
  ): Promise<CommitIndexPublicationResult> {
    assertConsistentPublication(publication);
    const key = versionKey(publication.manifest);
    const existing = this.#versions.get(key);
    if (existing !== undefined) {
      if (publicationFingerprint(existing) !== publicationFingerprint(publication)) {
        throw new IndexPublicationStoreConflict();
      }
      return {
        status: "already_published",
        publication: structuredClone(existing),
      };
    }

    const stored = structuredClone(publication);
    this.#versions.set(key, stored);
    this.#current.set(
      stored.manifest.documentIndexId,
      stored.manifest.indexVersion,
    );
    return { status: "published", publication: structuredClone(stored) };
  }
}

function assertConsistentPublication(publication: PublishedIndexVersion): void {
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
    throw new IndexPublicationStoreConflict();
  }
}

function publicationFingerprint(publication: PublishedIndexVersion): string {
  const { publishedAt: _publishedAt, ...manifest } = publication.manifest;
  return canonicalJson({
    manifest,
    securityDomain: publication.securityDomain,
    documentIndex: publication.documentIndex,
    scopes: publication.scopes,
  });
}

function versionKey(input: {
  readonly documentIndexId: string;
  readonly indexVersion: string;
}): string {
  return `${input.documentIndexId}\u0000${input.indexVersion}`;
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
