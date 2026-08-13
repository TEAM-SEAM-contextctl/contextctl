import {
  parsePublicationReady,
  type PublicationReady,
} from "@contextctl/contracts";

import type { PublicationReadyNotifier } from "../ports/markdown-publication.js";

export class InMemoryPublicationReadyNotifier
  implements PublicationReadyNotifier
{
  readonly #notifications: PublicationReady[] = [];

  get notifications(): readonly PublicationReady[] {
    return structuredClone(this.#notifications);
  }

  async notify(input: PublicationReady): Promise<void> {
    const notification = parsePublicationReady(
      JSON.parse(JSON.stringify(input)) as unknown,
    );
    this.#notifications.push(notification);
  }
}
