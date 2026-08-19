/**
 * The one way this domain measures how long a text is.
 *
 * `unicode-estimate-v1` is the profile name the admission limits are stated
 * under, and it is the same name Indexing uses for its own text measure. The two
 * are deliberately separate implementations of one agreed rule rather than a
 * shared function: a domain package may not import another domain package, and
 * the rule is one line.
 *
 * Code points, not UTF-16 code units and not tokens. Code units would count a
 * single emoji or a rare CJK ideograph as two, so the same sentence would
 * measure differently depending on which characters it happens to contain.
 * Tokens would be exact for one tokenizer and wrong for every other, and the
 * limit has to be checkable before a model is loaded — that is the whole point
 * of an *estimate* profile: it is an admission bound this package can apply
 * without asking a provider anything.
 */
export const TEXT_MEASURE_PROFILE_VERSION = "unicode-estimate-v1" as const;

/** How many `unicode-estimate-v1` units `text` costs. */
export function measureTextUnits(text: string): number {
  // The spread iterates code points; `text.length` would iterate code units.
  return [...text].length;
}
