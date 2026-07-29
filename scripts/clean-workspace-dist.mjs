import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = new URL("../", import.meta.url);

await Promise.all(
  ["apps", "packages"].map(async (workspaceRoot) => {
    const directory = new URL(`${workspaceRoot}/`, repositoryRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    const directoryPath = fileURLToPath(directory);

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          rm(resolve(directoryPath, entry.name, "dist"), {
            force: true,
            recursive: true,
          }),
        ),
    );
  }),
);
