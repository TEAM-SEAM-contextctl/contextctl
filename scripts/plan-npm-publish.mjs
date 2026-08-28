import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatReleasePlan,
  loadReleasePlan,
  publicPlan,
} from "./lib/npm-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--json")) {
  throw new Error("usage: node scripts/plan-npm-publish.mjs [--json]");
}

const plan = await loadReleasePlan(repositoryRoot);
process.stdout.write(
  arguments_[0] === "--json"
    ? `${JSON.stringify(publicPlan(plan), null, 2)}\n`
    : formatReleasePlan(plan),
);
