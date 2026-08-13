import type {
  MarkdownPublicationEventSink,
  MarkdownPublicationStageEvent,
} from "../ports/markdown-publication.js";

export class InMemoryMarkdownPublicationEventSink
  implements MarkdownPublicationEventSink
{
  readonly #events: MarkdownPublicationStageEvent[] = [];

  get events(): readonly MarkdownPublicationStageEvent[] {
    return structuredClone(this.#events);
  }

  record(event: MarkdownPublicationStageEvent): void {
    this.#events.push(structuredClone(event));
  }
}
