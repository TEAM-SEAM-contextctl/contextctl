import { z } from "zod";

export const NonEmptyTextSchema = z.string().min(1);
export const MachineNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export interface ContractValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Stable validation failure exposed by parsers at the package boundary. */
export class ContractValidationError extends Error {
  readonly issues: readonly ContractValidationIssue[];

  constructor(contract: string, issues: readonly ContractValidationIssue[]) {
    super(`${contract} failed validation with ${issues.length} issue(s)`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function parseContract<T>(
  contract: string,
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ContractValidationError(
    contract,
    result.error.issues.map((validationIssue) => ({
      code: validationIssue.code,
      path: validationIssue.path,
      message: validationIssue.message,
    })),
  );
}

export function validateSortedUnique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  const canonical = [...new Set(values)].sort();
  if (
    canonical.length !== values.length ||
    canonical.some((value, index) => value !== values[index])
  ) {
    context.addIssue({
      code: "custom",
      message: `${label} must be unique and lexically sorted`,
    });
  }
}

/** Deterministic JSON used by versioned contracts and their size limits. */
export function canonicalContractJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalContractJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalContractJson(record[key])}`,
    )
    .join(",")}}`;
}

export function canonicalContractByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalContractJson(value)).byteLength;
}
