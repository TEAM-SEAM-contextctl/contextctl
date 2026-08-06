import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@contextctl/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@contextctl/registry-lifecycle": fileURLToPath(
        new URL("./packages/registry-lifecycle/src/index.ts", import.meta.url),
      ),
      "@contextctl/selection-delivery": fileURLToPath(
        new URL("./packages/selection-delivery/src/index.ts", import.meta.url),
      ),
    },
  },
});
