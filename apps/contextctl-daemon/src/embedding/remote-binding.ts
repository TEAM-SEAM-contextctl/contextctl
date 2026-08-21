import { inspect } from "node:util";

/**
 * The runtime binding an OpenAI-compatible embedding provider is reached
 * through.
 *
 * Deliberately not part of any profile. A profile states what a vector *means* —
 * model, revision, dimensions, pooling, normalization — and two deployments that
 * rotate a key or move an endpoint in front of the same immutable model are
 * still producing vectors of the same family. Putting the endpoint in the
 * profile would make a key rotation look like a new vector space and force a
 * reindex that changes nothing.
 *
 * The layers hold one of these each, never a shared one: the document family and
 * the Card family are independently configured, so they may name different
 * providers entirely, and an instance carries a credential.
 */
export interface RemoteEmbeddingBinding {
  /**
   * The allowlist key a provider registry matches on.
   *
   * Not derived from the endpoint. Two endpoints can front one provider and one
   * endpoint can front several, so an operator names the provider explicitly
   * rather than having a hostname stand in for a trust decision.
   */
  readonly providerId: string;
  /** Absolute `https:` origin and path of the `/embeddings` surface. */
  readonly endpoint: string;
  readonly credential: EmbeddingCredential;
  /**
   * The isolation key this binding may be used under.
   *
   * Carried on the binding rather than assumed from the daemon's configured
   * domain so that a mismatch is a refusal rather than a silent widening: a
   * credential provisioned for one domain must not answer a query made under
   * another, and the check has to compare two stated values to be a check at
   * all.
   */
  readonly securityDomain: string;
}

/** What a redacted credential renders as, everywhere it could be rendered. */
export const REDACTED_CREDENTIAL = "[redacted]";

/**
 * A secret that cannot be printed by accident.
 *
 * The value lives in a `#private` field, which is not a convention but a
 * language-level guarantee: it is absent from `Object.keys`, from the spread
 * operator, from `JSON.stringify` and from structured clone, so the ways a
 * credential normally reaches a log — an object dumped into a message, an error
 * serialized by a handler, a config echoed at startup — cannot reach it.
 *
 * The three explicit overrides below close the paths that would otherwise
 * stringify the wrapper itself rather than its fields. `reveal()` is the only
 * way out and is named to be greppable: a review can find every place a
 * credential is unwrapped by searching for one word.
 */
export class EmbeddingCredential {
  readonly #value: string;

  constructor(value: string) {
    if (value.trim() === "") {
      throw new TypeError("an embedding credential must not be empty");
    }
    this.#value = value;
  }

  /**
   * Hands the secret to the code that puts it on the wire.
   *
   * Call sites are expected to be exactly one per binding: the adapter factory.
   * Anything else holding the raw string re-opens the leak this type closes.
   */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED_CREDENTIAL;
  }

  toString(): string {
    return REDACTED_CREDENTIAL;
  }

  [inspect.custom](): string {
    return REDACTED_CREDENTIAL;
  }
}

/**
 * The binding as it may appear in an operator-facing report.
 *
 * A separate type rather than a formatting convention. Status output, notices
 * and diagnostics take this shape, and it has no field a credential could be
 * assigned to — so "do not print the secret" is enforced by what the type can
 * hold rather than by remembering.
 */
export interface RemoteEmbeddingBindingReport {
  readonly providerId: string;
  readonly endpoint: string;
  readonly securityDomain: string;
  /** Names where the secret was read from. Never its value. */
  readonly credentialSource: string;
}

export function describeRemoteBinding(
  binding: RemoteEmbeddingBinding,
  credentialSource: string,
): RemoteEmbeddingBindingReport {
  return {
    providerId: binding.providerId,
    endpoint: binding.endpoint,
    securityDomain: binding.securityDomain,
    credentialSource,
  };
}

export type RemoteEmbeddingBindingProblemCode =
  | "credential_missing"
  | "endpoint_missing"
  | "endpoint_invalid"
  | "endpoint_carries_credentials"
  | "endpoint_insecure"
  | "provider_id_missing"
  | "security_domain_mismatch";

/**
 * A binding that could not be assembled.
 *
 * The message is built from the code and the layer alone. Nothing derived from
 * the operator's input reaches it — not the endpoint that failed to parse, not
 * the header that was rejected, and above all not the credential — because this
 * message is written to stderr and status output by callers who cannot know
 * which substring of an endpoint was the secret. An operator gets the variable
 * name to look at, which is enough to fix it and safe to print.
 */
export class RemoteEmbeddingBindingError extends Error {
  constructor(
    readonly code: RemoteEmbeddingBindingProblemCode,
    readonly layer: "document" | "card",
    /** The variable an operator should look at. Never a value. */
    readonly variable: string,
  ) {
    super(`${layer} embedding remote binding is invalid: ${code}`);
    this.name = "RemoteEmbeddingBindingError";
  }
}

/**
 * Validates an endpoint without ever putting it in a failure.
 *
 * The rules match the ones Ingestion's own OpenAI-compatible adapter applies, and
 * they are re-applied here rather than deferred to it because this is the layer
 * that reads operator configuration: a bad endpoint should stop the composition
 * with a variable name to fix, not surface later as a provider fault during a
 * query.
 *
 * Plaintext `http:` is confined to loopback. An embedding request carries the
 * document text and the user's query, so allowing it to a remote host would put
 * exactly the payload this whole path is careful about onto the network in the
 * clear.
 */
export function validateRemoteEndpoint(
  raw: string,
  layer: "document" | "card",
  variable: string,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new RemoteEmbeddingBindingError("endpoint_invalid", layer, variable);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new RemoteEmbeddingBindingError("endpoint_invalid", layer, variable);
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new RemoteEmbeddingBindingError(
      "endpoint_carries_credentials",
      layer,
      variable,
    );
  }
  if (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) {
    throw new RemoteEmbeddingBindingError("endpoint_insecure", layer, variable);
  }
  return endpoint.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
