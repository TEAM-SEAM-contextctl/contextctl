/**
 * The logical identity shared by every authoritative store in one deployment.
 *
 * These values are configuration, not request input. Keeping them in one
 * object prevents one store from being validated under a namespace while
 * another is opened under a silently re-read default.
 */
export interface DaemonStateIdentity {
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}

export const DEFAULT_DAEMON_STATE_IDENTITY: DaemonStateIdentity = Object.freeze({
  stateNamespaceId: "state_local",
  securityDomain: "local",
});

export const STATE_NAMESPACE_ID_VARIABLE = "CONTEXTCTL_STATE_NAMESPACE_ID";
export const SECURITY_DOMAIN_VARIABLE = "CONTEXTCTL_SECURITY_DOMAIN";

/** A deployment identity is invalid before any state store is opened. */
export class DaemonStateIdentityConfigurationError extends Error {
  readonly code = "state_identity_invalid";

  constructor(readonly field: keyof DaemonStateIdentity) {
    super(`Daemon state identity is invalid: ${field}`);
    this.name = "DaemonStateIdentityConfigurationError";
  }
}

/** Reads the identity exactly once from process configuration. */
export function readDaemonStateIdentity(
  environment: Readonly<Partial<Record<string, string>>>,
): DaemonStateIdentity {
  return assertDaemonStateIdentity({
    stateNamespaceId:
      environment[STATE_NAMESPACE_ID_VARIABLE] ??
      DEFAULT_DAEMON_STATE_IDENTITY.stateNamespaceId,
    securityDomain:
      environment[SECURITY_DOMAIN_VARIABLE] ??
      DEFAULT_DAEMON_STATE_IDENTITY.securityDomain,
  });
}

/** Validates programmatic compositions by the same rule as shell composition. */
export function assertDaemonStateIdentity(
  identity: DaemonStateIdentity,
): DaemonStateIdentity {
  for (const field of ["stateNamespaceId", "securityDomain"] as const) {
    const value = identity[field];
    if (value.trim() === "" || value !== value.trim()) {
      throw new DaemonStateIdentityConfigurationError(field);
    }
  }
  return Object.freeze({ ...identity });
}
