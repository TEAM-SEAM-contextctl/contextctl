import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { corpusDigest } from "./dataset.js";
import {
  DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
  DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
} from "./deferred-evidence-cover-v11-policy.js";

const benchmarkDirectory = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const repositoryRoot = resolve(benchmarkDirectory, "../..");
const publicCorpusDirectory = resolve(
  repositoryRoot,
  "apps/contextctl-daemon/demo/docs",
);
const [corpusArgument, ...unexpected] = process.argv.slice(2);
if (corpusArgument === undefined || unexpected.length > 0) {
  throw new Error(
    "usage: npm run seal:deferred-v11 -- /absolute/path/to/blind-corpus",
  );
}
const corpusDirectory = resolve(corpusArgument);
if (corpusDirectory === publicCorpusDirectory) {
  throw new Error("blind corpus must differ from the public demo corpus");
}
const corpus = await corpusDigest(corpusDirectory);
if (corpus.files === 0) {
  throw new Error("blind corpus contains no Markdown documents");
}
const policySource = await readFile(
  resolve(
    benchmarkDirectory,
    "src/deferred-evidence-cover-v11-policy.ts",
  ),
);
const fixtureHeader = {
  schemaVersion: 1,
  split: "shadow",
  sealedAt: new Date().toISOString(),
  frozenPolicyVersion: DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
  frozenPolicyDigest: DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
  frozenPolicySourceSha256: createHash("sha256")
    .update(policySource)
    .digest("hex"),
  frozenCorpusSha256: corpus.sha256,
  corpusFiles: corpus.files,
  catalogPolicyOverrides: [],
  queries: [],
};
process.stdout.write(`${JSON.stringify(fixtureHeader, undefined, 2)}\n`);
