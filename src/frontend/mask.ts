/**
 * The masked multi-line field's arithmetic, kept apart from React so it can
 * be tested on its own.
 *
 * The textarea never holds the real value: it shows one MASK per character
 * and keeps line breaks, so the shape of the text is visible and nothing
 * else. The real value lives in the component's state. When the textarea
 * changes (typing, paste, cut, delete, drop), the change is found by
 * comparing what it showed before with what it holds now, using the caret
 * to place the edit, and the same change is made to the real value.
 *
 * This works the same in every browser, unlike `-webkit-text-security`,
 * which older Firefox versions ignore and which leaves the value in the DOM.
 */

export const MASK = "•";

/** What the textarea shows for a value: masks, with the line breaks kept. */
export function maskOf(value: string): string {
  let out = "";
  for (const char of value) out += char === "\n" ? "\n" : MASK;
  return out;
}

/**
 * The real value after an edit.
 *
 * @param real     the real value before the edit
 * @param shown    what the textarea showed before (maskOf(real))
 * @param next     what the textarea holds now
 * @param caret    the caret (selectionEnd) after the edit
 */
export function applyMaskedEdit(
  real: string,
  shown: string,
  next: string,
  caret: number,
): string {
  // One mask per code point, so the real value is indexed by code point.
  const realChars = Array.from(real);
  // Everything after the caret was there before the edit, unchanged.
  const suffix = Math.max(
    0,
    Math.min(next.length - caret, shown.length, next.length),
  );
  // The edit starts where the old and new text first differ, and never
  // after the caret or inside the kept tail.
  const limit = Math.min(caret, shown.length - suffix, next.length - suffix);
  let prefix = 0;
  while (prefix < limit && shown[prefix] === next[prefix]) prefix++;
  const inserted = next.slice(prefix, next.length - suffix);
  const kept = realChars.slice(shown.length - suffix);
  return realChars.slice(0, prefix).join("") + inserted + kept.join("");
}
