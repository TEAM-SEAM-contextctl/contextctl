import { DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE } from "@contextctl/ingestion-indexing";
import { describe, expect, it } from "vitest";

import { composeDocumentEmbedding } from "../src/embedding/composition.js";
import {
  IngestionDocumentEmbeddingProviderFactory,
  LocalEmbeddingInferenceResourcePool,
} from "../src/embedding/provider-factory.js";
import {
  documentLayer,
  remoteDocumentProfile,
  SECURITY_DOMAIN,
} from "./embedding/fakes.js";

const artifactDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;

describe.skipIf(artifactDirectory === undefined)(
  "retained local document embedding",
  () => {
    it(
      "restores a reachable local provider after the active layer moves remote",
      async () => {
        const resources = new LocalEmbeddingInferenceResourcePool();
        try {
          const current = remoteDocumentProfile();
          const retained = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
          const composition = composeDocumentEmbedding({
            configuration: documentLayer("remote"),
            currentProfile: current,
            reachableProfiles: [current, retained],
            securityDomain: SECURITY_DOMAIN,
            factory: new IngestionDocumentEmbeddingProviderFactory(resources),
            retainedBindings: [
              {
                profileId: retained.id,
                profileVersion: retained.version,
                mode: "local",
                artifactDirectory: artifactDirectory!,
              },
            ],
          });
          const registration = composition.registrations.find(
            ({ embeddingProfile }) =>
              embeddingProfile.id === retained.id &&
              embeddingProfile.version === retained.version,
          );
          expect(registration).toBeDefined();
          await expect(
            registration!.provider.embed({
              profile: retained,
              inputs: [{ key: "query", text: "이전 색인 검색" }],
              signal: new AbortController().signal,
            }),
          ).resolves.toEqual([
            expect.objectContaining({
              key: "query",
              vector: expect.arrayContaining([expect.any(Number)]),
            }),
          ]);
        } finally {
          await resources.close();
        }
      },
      120_000,
    );
  },
);
