/**
 * What each outcome means to a program, stated once.
 *
 * A CLI that folds every failure into `1` tells a script only that something went
 * wrong, and the two things an operator does next are completely different: a
 * mistyped flag is fixed in the script, a release gate that did not pass stops a
 * deploy. Registry already separates those cases — `runOperatorCommand` returns
 * four statuses rather than a boolean — and collapsing them here would throw away
 * the distinction at the last step.
 *
 * The numbers are a contract with whatever runs `contextctl`, so they live in one
 * table rather than at each call site. `2` for a usage error is the POSIX
 * convention; the rest are ours, and only two properties actually matter: every
 * failure is non-zero, and no two failures share a code.
 */
export const EXIT_CODES = {
  /** The command did what it was asked. */
  ok: 0,
  /**
   * The command was well-formed and Registry refused the decision — an
   * unvalidated version, a Card that does not exist, a rollback that would move
   * the pointer forward.
   */
  refused: 1,
  /** The command line itself was wrong. Nothing was attempted. */
  usageError: 2,
  /**
   * A release gate did not pass: `broken` Scopes, or `orphaned` ones with no
   * recorded reason. Separate from `refused` because CI branches on it — this is
   * the code that makes `registry-reachability-v1` enforceable rather than
   * merely printable.
   */
  gateFailed: 3,
  /**
   * A Source is behind: a Publication arrived before its predecessor, so nothing
   * was consumed and the checkpoint did not move. Non-zero because the run did
   * not do what it was asked, and distinct from a fork because **this one
   * resolves itself** once the missing Publication is delivered.
   */
  chainDeferred: 4,
  /**
   * A Source's Publication chain is not linear and consumption stopped. Distinct
   * from `chainDeferred` because no retry will clear it: two Publications claim
   * the same place and a person has to decide which one the Source follows.
   */
  chainForked: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * The code for one Registry operator status.
 *
 * Kept beside the table rather than in `commands.ts` so that adding a status to
 * `OperatorCommandResult` fails here — at the one place that knows what the
 * numbers mean — instead of falling through a default at a call site.
 */
export function operatorExitCode(
  status: "ok" | "usage_error" | "refused" | "gate_failed",
): ExitCode {
  switch (status) {
    case "ok":
      return EXIT_CODES.ok;
    case "usage_error":
      return EXIT_CODES.usageError;
    case "refused":
      return EXIT_CODES.refused;
    case "gate_failed":
      return EXIT_CODES.gateFailed;
    default: {
      const unreachable: never = status;
      throw new Error(`unknown operator command status: ${String(unreachable)}`);
    }
  }
}
