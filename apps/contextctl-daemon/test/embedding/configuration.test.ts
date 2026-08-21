import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CARD_EMBEDDING_API_KEY_VARIABLE,
  CARD_EMBEDDING_ENDPOINT_VARIABLE,
  CARD_EMBEDDING_MODE_VARIABLE,
  DOCUMENT_EMBEDDING_API_KEY_VARIABLE,
  DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE,
  DOCUMENT_EMBEDDING_MODE_VARIABLE,
  DOCUMENT_EMBEDDING_PROVIDER_ID_VARIABLE,
  EmbeddingModeError,
  readEmbeddingCompositionConfiguration,
} from "../../src/embedding/configuration.js";
import {
  EmbeddingCredential,
  REDACTED_CREDENTIAL,
  RemoteEmbeddingBindingError,
} from "../../src/embedding/remote-binding.js";

const DOMAIN = "local";

/** A secret that would be unmistakable in any output that leaked it. */
const SECRET = "sk-live-do-not-print-me";

describe("embedding configuration", () => {
  describe("independence of the two layers", () => {
    it("defaults both layers to local when nothing is set", () => {
      const configuration = readEmbeddingCompositionConfiguration({}, DOMAIN);

      expect(configuration.document.mode).toBe("local");
      expect(configuration.card.mode).toBe("local");
    });

    it("reads one layer remote while the other stays local", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
          [CARD_EMBEDDING_ENDPOINT_VARIABLE]: "https://cards.example/v1/embeddings",
          [CARD_EMBEDDING_API_KEY_VARIABLE]: SECRET,
        },
        DOMAIN,
      );

      expect(configuration.document.mode).toBe("local");
      expect(configuration.card.mode).toBe("remote");
    });

    it("gives each layer its own endpoint and credential", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
          [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]:
            "https://documents.example/v1/embeddings",
          [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: "document-key",
          [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
          [CARD_EMBEDDING_ENDPOINT_VARIABLE]: "https://cards.example/v1/embeddings",
          [CARD_EMBEDDING_API_KEY_VARIABLE]: "card-key",
        },
        DOMAIN,
      );

      // Two providers, reachable at two endpoints, holding two credentials. A
      // deployment that pointed both layers at one provider would still be two
      // bindings; sharing the instance would mean sharing the key.
      if (configuration.document.mode !== "remote") throw new Error("unreachable");
      if (configuration.card.mode !== "remote") throw new Error("unreachable");
      expect(configuration.document.binding.endpoint).toBe(
        "https://documents.example/v1/embeddings",
      );
      expect(configuration.card.binding.endpoint).toBe(
        "https://cards.example/v1/embeddings",
      );
      expect(configuration.document.binding.credential.reveal()).toBe(
        "document-key",
      );
      expect(configuration.card.binding.credential.reveal()).toBe("card-key");
    });

    it("names a provider id per layer when none was given", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
          [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: "https://documents.example/v1",
          [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
        },
        DOMAIN,
      );

      if (configuration.document.mode !== "remote") throw new Error("unreachable");
      expect(configuration.document.binding.providerId).toBe(
        "remote.local.document",
      );
    });

    it("takes an explicit provider id for the allowlist", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
          [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: "https://documents.example/v1",
          [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
          [DOCUMENT_EMBEDDING_PROVIDER_ID_VARIABLE]: "acme-hosted",
        },
        DOMAIN,
      );

      if (configuration.document.mode !== "remote") throw new Error("unreachable");
      expect(configuration.document.binding.providerId).toBe("acme-hosted");
    });
  });

  describe("refusing a partial remote layer", () => {
    it("refuses an endpoint with no credential", () => {
      expect(() =>
        readEmbeddingCompositionConfiguration(
          {
            [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
            [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: "https://documents.example/v1",
          },
          DOMAIN,
        ),
      ).toThrowError(RemoteEmbeddingBindingError);
    });

    it("refuses a credential with no endpoint", () => {
      expect(() =>
        readEmbeddingCompositionConfiguration(
          {
            [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
            [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
          },
          DOMAIN,
        ),
      ).toThrowError(RemoteEmbeddingBindingError);
    });

    it("does not quietly stay local when remote cannot be bound", () => {
      // The failure mode this refusal exists for: an operator whose key never
      // reached the process would otherwise get a working daemon that had
      // silently kept using the local model, and would find out when the vectors
      // in their index turned out to be from the wrong one.
      let configuration: unknown;
      try {
        configuration = readEmbeddingCompositionConfiguration(
          {
            [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
            [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: "https://documents.example/v1",
          },
          DOMAIN,
        );
      } catch {
        configuration = undefined;
      }
      expect(configuration).toBeUndefined();
    });

    it("refuses a mode it does not recognise", () => {
      expect(() =>
        readEmbeddingCompositionConfiguration(
          { [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "hybrid" },
          DOMAIN,
        ),
      ).toThrowError(EmbeddingModeError);
    });
  });

  describe("endpoints that would put payloads at risk", () => {
    it("refuses a credential embedded in the URL", () => {
      expect(() =>
        readEmbeddingCompositionConfiguration(
          {
            [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
            [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]:
              "https://user:pass@documents.example/v1",
            [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
          },
          DOMAIN,
        ),
      ).toThrowError(RemoteEmbeddingBindingError);
    });

    it("refuses plaintext http to a remote host", () => {
      // An embedding request carries the document text and the user's query, so
      // an unencrypted hop would put exactly the payload this path protects onto
      // the network in the clear.
      expect(() =>
        readEmbeddingCompositionConfiguration(
          {
            [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
            [CARD_EMBEDDING_ENDPOINT_VARIABLE]: "http://cards.example/v1",
            [CARD_EMBEDDING_API_KEY_VARIABLE]: SECRET,
          },
          DOMAIN,
        ),
      ).toThrowError(RemoteEmbeddingBindingError);
    });

    it("allows plaintext http to loopback", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
          [CARD_EMBEDDING_ENDPOINT_VARIABLE]: "http://localhost:8080/v1/embeddings",
          [CARD_EMBEDDING_API_KEY_VARIABLE]: SECRET,
        },
        DOMAIN,
      );

      expect(configuration.card.mode).toBe("remote");
    });
  });

  describe("a credential that cannot be printed by accident", () => {
    it("keeps the secret out of every stringification path", () => {
      const credential = new EmbeddingCredential(SECRET);

      expect(String(credential)).toBe(REDACTED_CREDENTIAL);
      expect(JSON.stringify(credential)).toBe(`"${REDACTED_CREDENTIAL}"`);
      expect(inspect(credential)).toBe(REDACTED_CREDENTIAL);
      expect(`${credential}`).not.toContain(SECRET);
    });

    it("keeps it out of a binding that gets serialized whole", () => {
      const configuration = readEmbeddingCompositionConfiguration(
        {
          [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
          [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: "https://documents.example/v1",
          [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
        },
        DOMAIN,
      );

      // The realistic leak: a whole configuration object logged at startup, or
      // an error handler serializing what it was given.
      const serialized = JSON.stringify(configuration);
      expect(serialized).not.toContain(SECRET);
      expect(inspect(configuration, { depth: null })).not.toContain(SECRET);
    });

    it("keeps it out of a binding failure", () => {
      // The endpoint is what failed, but nothing here can tell which substring
      // of an operator's configuration was sensitive, so the message is built
      // from a code and a variable name and carries no value at all.
      let message = "";
      try {
        readEmbeddingCompositionConfiguration(
          {
            [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
            [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]: `https://documents.example/v1?token=${SECRET}`,
            [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: SECRET,
          },
          DOMAIN,
        );
      } catch (error) {
        message = error instanceof Error ? `${error.message}${error.stack}` : "";
      }
      expect(message).not.toContain(SECRET);
    });

    it("refuses an empty credential rather than binding one", () => {
      expect(() => new EmbeddingCredential("   ")).toThrowError(TypeError);
    });
  });
});
