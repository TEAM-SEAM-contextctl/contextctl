import { createHash } from "node:crypto";

export function rootId(
  prefix: "doc" | "obs" | "pub" | "src",
  seed: string | number,
): string {
  return persistedId(prefix, `${prefix}:${String(seed)}`);
}

export function structuralId(
  prefix: "blk" | "chk" | "unit",
  seed: string | number,
): string {
  return persistedId(prefix, `${prefix}_${String(seed)}`);
}

function persistedId(prefix: string, seed: string): string {
  const random = createHash("sha256").update(seed).digest("hex");
  return `${prefix}_01890f5c-7b1a-7${random.slice(0, 3)}-8${random.slice(
    3,
    6,
  )}-${random.slice(6, 18)}`;
}
