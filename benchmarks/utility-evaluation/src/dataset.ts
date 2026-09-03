import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  EvaluationDataset,
  EvaluationSplit,
  QueryFixture,
  SelectionExpectation,
} from "./types.js";

export async function readEvaluationDataset(input: {
  readonly path: string;
  readonly expectedSplit: EvaluationSplit;
  readonly corpusDirectory: string;
}): Promise<EvaluationDataset> {
  const raw = await readFile(input.path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1) {
    throw new Error("evaluation fixture must use schemaVersion 1");
  }
  if (parsed["split"] !== input.expectedSplit) {
    throw new Error(
      `fixture split mismatch: expected ${input.expectedSplit}`,
    );
  }
  if (!Array.isArray(parsed["queries"]) || parsed["queries"].length === 0) {
    throw new Error("evaluation fixture must contain queries");
  }
  const queries = parsed["queries"].map(parseQuery);
  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.id)) throw new Error(`duplicate query id: ${query.id}`);
    ids.add(query.id);
  }

  const corpus = await readCorpus(input.corpusDirectory);
  for (const query of queries) {
    validateAgainstCorpus(query, corpus);
  }
  const sealedAt = parsed["sealedAt"];
  if (
    input.expectedSplit !== "development" &&
    (typeof sealedAt !== "string" || !Number.isFinite(Date.parse(sealedAt)))
  ) {
    throw new Error(`${input.expectedSplit} fixture must carry a valid sealedAt timestamp`);
  }
  const frozenPolicyDigest = parsed["frozenPolicyDigest"];
  const frozenPolicySourceSha256 = parsed["frozenPolicySourceSha256"];
  if (
    input.expectedSplit === "shadow" &&
    (!isSha256Digest(frozenPolicyDigest) ||
      !isRawSha256(frozenPolicySourceSha256))
  ) {
    throw new Error(
      "shadow fixture must identify the policy definition frozen before it was written",
    );
  }

  return {
    split: input.expectedSplit,
    queries,
    sha256: createHash("sha256").update(raw).digest("hex"),
    ...(typeof sealedAt === "string" ? { sealedAt } : {}),
    ...(typeof frozenPolicyDigest === "string" ? { frozenPolicyDigest } : {}),
    ...(typeof frozenPolicySourceSha256 === "string"
      ? { frozenPolicySourceSha256 }
      : {}),
  };
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRawSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export async function corpusDigest(
  directory: string,
): Promise<{ readonly files: number; readonly sha256: string }> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".md"))
    .sort(compareText);
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(join(directory, name)));
    hash.update("\0");
  }
  return { files: names.length, sha256: hash.digest("hex") };
}

async function readCorpus(directory: string): Promise<string> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".md"))
    .sort(compareText);
  if (names.length === 0) throw new Error("evaluation corpus is empty");
  return (
    await Promise.all(names.map(async (name) => await readFile(join(directory, name), "utf8")))
  ).join("\n\n");
}

function parseQuery(value: unknown, index: number): QueryFixture {
  if (!isRecord(value)) {
    throw new Error(`query ${String(index)} must be an object`);
  }
  const id = requiredString(value["id"], `query ${String(index)} id`);
  const category = requiredString(
    value["category"],
    `query ${id} category`,
  );
  const query = requiredString(value["query"], `query ${id} text`);
  if (typeof value["expectedAnswerable"] !== "boolean") {
    throw new Error(`query ${id} expectedAnswerable must be boolean`);
  }
  const requiredFacts = stringArray(value["requiredFacts"], id, "requiredFacts");
  const relevantChunkAnchors = stringArray(
    value["relevantChunkAnchors"],
    id,
    "relevantChunkAnchors",
  );
  const selectionExpectation = parseSelectionExpectation(
    value["selectionExpectation"],
    id,
    value["expectedAnswerable"],
  );
  if (
    value["expectedAnswerable"] &&
    (requiredFacts.length === 0 || relevantChunkAnchors.length === 0)
  ) {
    throw new Error(`answerable query ${id} needs facts and chunk anchors`);
  }
  if (!value["expectedAnswerable"] && requiredFacts.length !== 0) {
    throw new Error(`unanswerable query ${id} cannot carry required facts`);
  }
  if (
    selectionExpectation.kind === "close_unanswerable" &&
    relevantChunkAnchors.length === 0
  ) {
    throw new Error(
      `close-unanswerable query ${id} needs related Chunk anchors`,
    );
  }
  if (
    (selectionExpectation.kind === "unrelated" ||
      selectionExpectation.kind === "forbidden") &&
    relevantChunkAnchors.length !== 0
  ) {
    throw new Error(
      `${selectionExpectation.kind} query ${id} cannot carry Chunk anchors`,
    );
  }
  return {
    id,
    category,
    query,
    expectedAnswerable: value["expectedAnswerable"],
    requiredFacts,
    relevantChunkAnchors,
    selectionExpectation,
  };
}

function parseSelectionExpectation(
  value: unknown,
  id: string,
  expectedAnswerable: boolean,
): SelectionExpectation {
  if (value === undefined) {
    return {
      kind: expectedAnswerable
        ? "answerable"
        : "legacy_unclassified_unanswerable",
      allowedCardDescriptions: [],
    };
  }
  if (!isRecord(value)) {
    throw new Error(`query ${id} selectionExpectation must be an object`);
  }
  const kind = value["kind"];
  if (
    kind !== "answerable" &&
    kind !== "close_unanswerable" &&
    kind !== "unrelated" &&
    kind !== "forbidden"
  ) {
    throw new Error(`query ${id} has an invalid Selection expectation kind`);
  }
  const allowedCardDescriptions = stringArray(
    value["allowedCardDescriptions"],
    id,
    "selectionExpectation.allowedCardDescriptions",
  );
  if ((kind === "answerable") !== expectedAnswerable) {
    throw new Error(
      `query ${id} answerability disagrees with its Selection expectation`,
    );
  }
  if (kind === "close_unanswerable" && allowedCardDescriptions.length === 0) {
    throw new Error(
      `close-unanswerable query ${id} needs allowed Card descriptions`,
    );
  }
  if (
    (kind === "unrelated" || kind === "forbidden") &&
    allowedCardDescriptions.length !== 0
  ) {
    throw new Error(
      `${kind} query ${id} cannot allow Card descriptions`,
    );
  }
  return { kind, allowedCardDescriptions };
}

function validateAgainstCorpus(query: QueryFixture, corpus: string): void {
  for (const fact of [...query.requiredFacts, ...query.relevantChunkAnchors]) {
    if (!corpus.includes(fact)) {
      throw new Error(`query ${query.id} evidence is absent from corpus: ${fact}`);
    }
  }
}

function stringArray(
  value: unknown,
  id: string,
  field: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => typeof entry === "string" && entry.trim() !== "",
    )
  ) {
    throw new Error(`query ${id} ${field} must be a string array`);
  }
  return Object.freeze([...new Set(value)]);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
