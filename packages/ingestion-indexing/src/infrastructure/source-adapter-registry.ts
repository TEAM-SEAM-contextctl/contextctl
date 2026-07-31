import type {
  SourceAdapter,
  SourceAdapterResolver,
} from "../ports/source-adapter.js";

export class SourceAdapterRegistry implements SourceAdapterResolver {
  readonly #adapters: ReadonlyMap<string, SourceAdapter>;

  constructor(adapters: readonly SourceAdapter[]) {
    const registry = new Map<string, SourceAdapter>();
    for (const adapter of adapters) {
      if (registry.has(adapter.sourceType)) {
        throw new Error(`Duplicate Source adapter: ${adapter.sourceType}`);
      }
      registry.set(adapter.sourceType, adapter);
    }
    this.#adapters = registry;
  }

  resolve(sourceType: string): SourceAdapter | undefined {
    return this.#adapters.get(sourceType);
  }
}
