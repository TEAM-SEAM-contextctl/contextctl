import type { LaneName, LaneStatus } from "./status.js";

/** One status lane before a terminal chooses its column layout. */
export interface StatusDisplayRow {
  readonly lane: LaneName;
  readonly status: LaneStatus;
  readonly detail: string;
}

/** Explicit structure for human stdout that may adapt to a terminal width. */
export type CliStdoutPresentation = {
  readonly kind: "status";
  readonly rows: readonly StatusDisplayRow[];
};
