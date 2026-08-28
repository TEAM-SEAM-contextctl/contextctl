import { describe, expect, it, vi } from "vitest";

import { decideAssetInstallationConsent } from "../../src/cli/asset-installation-consent.js";

describe("decideAssetInstallationConsent", () => {
  it("treats --yes as explicit consent in any environment", () => {
    const confirm = vi.fn(async () => false);

    expect(
      decideAssetInstallationConsent({ yes: true, stdinIsTTY: false, confirm }),
    ).toEqual({ kind: "granted" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps a real terminal prompt as the only implicit interaction", () => {
    const confirm = vi.fn(async () => true);

    const consent = decideAssetInstallationConsent({
      yes: false,
      stdinIsTTY: true,
      confirm,
    });

    expect(consent).toEqual({ kind: "prompt", confirm });
  });

  it("requires --yes when no terminal can answer", () => {
    const confirm = vi.fn(async () => true);

    expect(
      decideAssetInstallationConsent({ yes: false, stdinIsTTY: false, confirm }),
    ).toEqual({ kind: "required" });
    expect(confirm).not.toHaveBeenCalled();
  });
});
