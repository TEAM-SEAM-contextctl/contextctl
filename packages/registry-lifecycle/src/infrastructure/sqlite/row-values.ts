/**
 * Column readers for rows coming back from SQLite.
 *
 * A stored row is untrusted input like any other: the schema may have been
 * written by an older build, so each column is checked rather than asserted
 * into shape with a cast.
 */
export type SqlRow = Record<string, unknown>;

export class RegistryRowError extends Error {
  constructor(column: string, value: unknown) {
    super(`column ${column} holds an unexpected value: ${String(value)}`);
    this.name = "RegistryRowError";
  }
}

export function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new RegistryRowError(column, value);
  }
  return value;
}

export function readOptionalText(
  row: SqlRow,
  column: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RegistryRowError(column, value);
  }
  return value;
}

export function readInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new RegistryRowError(column, value);
}

export function readJson<T>(row: SqlRow, column: string): T {
  return JSON.parse(readText(row, column)) as T;
}
