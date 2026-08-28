/** How the command layer obtained permission for a filesystem-changing install. */
export type AssetInstallationConsent =
  | { readonly kind: "granted" }
  | {
      readonly kind: "prompt";
      readonly confirm: () => Promise<boolean>;
    }
  | { readonly kind: "required" };

/**
 * Silence is never consent. `--yes` is the only unattended opt-in; a prompt is
 * reserved for a real terminal with someone available to answer it.
 */
export function decideAssetInstallationConsent(input: {
  readonly yes: boolean;
  readonly stdinIsTTY: boolean;
  readonly confirm: () => Promise<boolean>;
}): AssetInstallationConsent {
  if (input.yes) {
    return { kind: "granted" };
  }
  return input.stdinIsTTY
    ? { kind: "prompt", confirm: input.confirm }
    : { kind: "required" };
}
