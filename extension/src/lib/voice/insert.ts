// Pure helper for the Voice Command module: splice a dictated transcript
// into a text field at the caret / over the current selection. Extracted
// so the caret math + smart word-spacing can be unit-tested without a DOM
// (mirrors the report.ts pure-helper pattern).

/**
 * Insert `text` into `value`, replacing the range `[selStart, selEnd)`.
 * Adds a single space when joining to adjacent words so consecutive
 * dictations don't run together ("hellothere") — but never doubles up
 * existing whitespace, and never adds leading/trailing padding at the
 * very start / end of the field.
 *
 * Returns the new value and where the caret should land (just after the
 * inserted text). Indices are clamped, so out-of-range selections (or a
 * field that reports `null` selection) are safe.
 */
export function insertAtCaret(
  value: string,
  selStart: number,
  selEnd: number,
  text: string,
): { value: string; caret: number } {
  const len = value.length;
  const s = Math.max(0, Math.min(selStart, len));
  const e = Math.max(s, Math.min(selEnd, len));
  const before = value.slice(0, s);
  const after = value.slice(e);

  let insert = text;
  // Join to a preceding word with one space.
  if (before !== "" && !/\s$/.test(before) && !/^\s/.test(insert)) {
    insert = " " + insert;
  }
  // Join to a following word with one space.
  if (after !== "" && !/^\s/.test(after) && !/\s$/.test(insert)) {
    insert = insert + " ";
  }

  const nextValue = before + insert + after;
  const caret = before.length + insert.length;
  return { value: nextValue, caret };
}
