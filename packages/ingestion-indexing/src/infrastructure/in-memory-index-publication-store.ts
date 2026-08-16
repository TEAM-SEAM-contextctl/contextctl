import {
  parsePublishedIndexVersion,
  publishedIndexVersionFingerprint,
} from "../domain/published-index-version.js";
import {
  IndexPublicationStoreConflict,
  type CommitIndexPublicationResult as CommitLegacyIndexPublicationResult,
  type CommitIndexPublicationV2Result as CommitIndexPublicationResult,
  type IndexPublicationStore as LegacyIndexPublicationStore,
  type IndexPublicationStoreV2 as IndexPublicationStore,
  type PublishedIndexVersion as LegacyPublishedIndexVersion,
  type PublishedIndexVersionV2 as PublishedIndexVersion,
  type PublishedScopeCatalogEntry,
} from "../ports/index-publication-store.js";
import type { PublishedScopeRefV2 as PublishedScopeRef } from "@contextctl/contracts";
import { canonicalJson } from "../domain/revision-identity.js";

/** @deprecated Pre-release v1 store retained for downstream migration. */
export class InMemoryIndexPublicationStore implements LegacyIndexPublicationStore {
  readonly #versions = new Map<string, LegacyPublishedIndexVersion>();
  readonly #current = new Map<string, string>();

  async findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<LegacyPublishedIndexVersion | undefined> {
    return clone(this.#versions.get(versionKey(input)));
  }

  async current(
    documentIndexId: string,
  ): Promise<LegacyPublishedIndexVersion | undefined> {
    const indexVersion = this.#current.get(documentIndexId);
    return indexVersion === undefined
      ? undefined
      : clone(this.#versions.get(versionKey({ documentIndexId, indexVersion })));
  }

  async commitCurrent(
    publication: LegacyPublishedIndexVersion,
  ): Promise<CommitLegacyIndexPublicationResult> {
    const stored = structuredClone(publication);
    const key = versionKey(stored.manifest);
    const existing = this.#versions.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(stored)) {
        throw new IndexPublicationStoreConflict();
      }
      return { status: "already_published", publication: structuredClone(existing) };
    }
    this.#versions.set(key, stored);
    this.#current.set(stored.manifest.documentIndexId, stored.manifest.indexVersion);
    return { status: "published", publication: structuredClone(stored) };
  }
}

export class InMemoryIndexPublicationStoreV2 implements IndexPublicationStore {
  readonly #versions = new Map<string, PublishedIndexVersion>();
  readonly #current = new Map<string, string>();
  readonly #scopes = new Map<string, PublishedScopeCatalogEntry>();

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

  async findScope(
    scopeRef: PublishedScopeRef,
  ): Promise<PublishedScopeCatalogEntry | undefined> {
    return clone(this.#scopes.get(scopeKey(scopeRef)));
  }

  async commitCurrent(
    publication: PublishedIndexVersion,
  ): Promise<CommitIndexPublicationResult> {
    let validated: PublishedIndexVersion;
    try {
      validated = parsePublishedIndexVersion(
        JSON.parse(JSON.stringify(publication)) as unknown,
      );
    } catch {
      throw new IndexPublicationStoreConflict();
    }
    const key = versionKey(validated.manifest);
    const existing = this.#versions.get(key);
    if (existing !== undefined) {
      if (
        publishedIndexVersionFingerprint(existing) !==
        publishedIndexVersionFingerprint(validated)
      ) {
        throw new IndexPublicationStoreConflict();
      }
      return {
        status: "already_published",
        publication: structuredClone(existing),
      };
    }

    const stored = structuredClone(validated);
    for (const scope of stored.scopes) {
      const key = scopeKey(scope);
      const existingScope = this.#scopes.get(key);
      if (
        existingScope !== undefined &&
        canonicalJson(existingScope) !==
          canonicalJson({ publication: stored, scope })
      ) {
        throw new IndexPublicationStoreConflict();
      }
    }
    this.#versions.set(key, stored);
    this.#current.set(
      stored.manifest.documentIndexId,
      stored.manifest.indexVersion,
    );
    for (const scope of stored.scopes) {
      this.#scopes.set(scopeKey(scope), { publication: stored, scope });
    }
    return { status: "published", publication: structuredClone(stored) };
  }
}

function scopeKey(input: PublishedScopeRef): string {
  return `${input.scopeId}\u0000${input.scopeVersion}`;
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
