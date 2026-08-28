import {
  DEFAULT_POLICY_CONTEXT,
  type PolicyContext,
} from "@contextctl/selection-delivery";

import { readNonEmpty } from "./paths.js";

/**
 * The one operator setting behind the `PolicyContext`.
 *
 * `usage` is not configurable — v1 defines no purpose other than retrieval, so
 * a variable for it would be a permission nobody decided to grant. What an
 * operator can decide is whether Cards approved as sensitive may be reached by
 * queries at all, and that is this variable, read once here for every surface
 * the process serves.
 */
export const SENSITIVE_ACCESS_VARIABLE = "CONTEXTCTL_SENSITIVE_ACCESS";

const SENSITIVE_ACCESS_VALUES = ["deny", "allow"] as const;

/** The access policy variable carries a value this CLI does not define. */
export class PolicyContextConfigurationError extends Error {
  readonly code = "sensitive_access_invalid";

  constructor(received: string) {
    super(
      `[sensitive_access_invalid] ${SENSITIVE_ACCESS_VARIABLE} 는 deny 또는 allow 만 받는다. 받은 값: ${JSON.stringify(received)}. 민감 Card를 질의에서 제외하려면 변수를 비우고(기본값 deny), 노출하려면 allow 로 설정하라.`,
    );
    this.name = "PolicyContextConfigurationError";
  }
}

/**
 * Builds the `PolicyContext` this process runs every query under.
 *
 * One function, called by every composition path — the CLI runtime behind
 * `query`, the served process behind MCP and HTTP, and `doctor` — so the three
 * surfaces cannot read the environment differently and return different
 * answers to the same question (the access-surface equivalence invariant).
 *
 * Unset is `deny`, the documented default. Any other value than the two
 * defined ones is refused rather than read as the default, the rule every
 * tuning variable follows: an operator who wrote `Allow` or `yes` meant to
 * change something, and honouring it as `deny` would hide exactly that.
 */
export function resolvePolicyContext(
  environment: Readonly<Partial<Record<string, string>>>,
): PolicyContext {
  const raw = readNonEmpty(environment, SENSITIVE_ACCESS_VARIABLE);
  if (raw === undefined) {
    return DEFAULT_POLICY_CONTEXT;
  }
  const value = SENSITIVE_ACCESS_VALUES.find((candidate) => candidate === raw);
  if (value === undefined) {
    throw new PolicyContextConfigurationError(raw);
  }
  return { usage: "retrieval", sensitiveAccess: value };
}
