/**
 * Containing a string somebody else chose, where the app speaks in its own
 * voice.
 *
 * ## The property, and why it is containment rather than cleaning
 *
 * Three different inputs reach the console's own chrome: a note path out of a
 * bucket we do not own, a display name out of a presence room, and text a
 * plugin chose. All three are drawn beside Context's own words — the status
 * bar, the breadcrumb, a card next to the Stop button — and a bidi override
 * inside any of them reverses the rendering of *everything after it*, which
 * includes the app's own labels.
 *
 * There are two ways to answer that and they are not equally strong:
 *
 *  - **Stripping is a blocklist.** It works exactly as far as the list of
 *    hostile characters reaches, and every character nobody enumerated passes
 *    through. Two lists in this repository prove the point: one spells the
 *    class `[\p{Cc}\p{Cf}]` and misses U+2028 LINE SEPARATOR, which is `Zl`;
 *    the other spells it as hand-written ranges and misses U+061C ARABIC
 *    LETTER MARK — a character the bidi algorithm acts on — along with the
 *    U+FFF9–FFFB annotation set.
 *  - **Isolating is a whitelist of structure.** The value arrives inside a
 *    container the bidi algorithm cannot be talked out of: whatever is in
 *    there resolves its own direction and cannot reach the text around it.
 *    Characters nobody enumerated are contained too, because containment does
 *    not depend on recognising them.
 *
 * So this isolates. What it removes, it removes only where an isolate
 * *cannot* do the job.
 *
 * ## What isolation does and does not buy, stated rather than implied
 *
 * **Buys:** a hostile value cannot reorder, reverse or relocate anything
 * outside itself. The label beside it, the version, the word "Private", the
 * Stop button's row — none of them can be made to render as something else by
 * a character inside somebody's filename.
 *
 * **Does not buy:** a value can still misrender *itself*. `sei<RLO>fdp.md`
 * inside an isolate is still a name that reads back to front. Making the value
 * render truthfully means altering it, and for a path that is the wrong trade
 * — the path in the status bar is also the path somebody copies out of it, so
 * a displayed value that differs from the real key is its own defect. Where
 * altering it IS right, because nothing downstream copies the value, the
 * caller strips first and isolates after; `shareTitle.ts` is that case and
 * keeps its strip.
 *
 * ## The two removals, and why each is not an exception to the rule
 *
 * 1. **`\p{Cc}`, U+2028 and U+2029 are removed.** A C0 control, DEL, a line
 *    separator and a paragraph separator have no rendering to contain — they
 *    break the line the label sits on, inside an isolate as readily as outside
 *    one. An isolate is the wrong instrument rather than a weaker one.
 * 2. **U+2069 PDI and U+202C PDF are removed.** These are the *pops*: a PDI
 *    inside the value closes the container early and hands the rest of the
 *    string the reach this function exists to deny. A container that the
 *    contents can end is not a container. Nothing legitimate is lost, because
 *    a pop with nothing to pop has no effect in the first place — every
 *    embedding the value opens is closed by the PDI this appends.
 *
 * Both are what makes the isolate *hold*, which is why they live here and not
 * in a list each caller keeps.
 *
 * ## Why this is a `.cjs` file in `packages/shared`
 *
 * Its callers include `packages/obsidian-runtime`, which has **no
 * dependencies** by construction, and the gateway, which has none either.
 * Neither can import this package's TypeScript. The same reasoning put
 * `storageLayout.cjs` and `activity.cjs` here, and those are imported by
 * relative path from the zero-dependency halves of the product. A second copy
 * of this rule in each of them is the drift this file exists to end.
 */

/** FIRST STRONG ISOLATE — opens a container whose direction is its own. */
const FIRST_STRONG_ISOLATE = "\u2068";
/** POP DIRECTIONAL ISOLATE — closes it. */
const POP_DIRECTIONAL_ISOLATE = "\u2069";
/** POP DIRECTIONAL FORMATTING — closes an *embedding*, and escapes ours. */
const POP_DIRECTIONAL_FORMATTING = "\u202c";

/**
 * Characters an isolate cannot contain, so they are removed instead.
 *
 * `\p{Cc}` is C0 and DEL. U+2028 and U+2029 are `Zl`/`Zp` — the reason they
 * are named separately is that the `[\p{Cc}\p{Cf}]` spelling elsewhere in this
 * repository does not cover them, and a line separator in a status bar label
 * is a broken layout whichever category it belongs to.
 */
const UNCONTAINABLE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** The two pops, which would end the container from inside it. */
const POPS = /[\u2069\u202c]/gu;

/** Any format character. If one survives the removals, the value is contained. */
const FORMAT_CHARACTER = /\p{Cf}/u;

/**
 * Remove what an isolate cannot contain.
 *
 * Exported on its own because a caller that has already decided to *alter* the
 * value — a share card's title, where nothing downstream copies it — still
 * wants this half, and wants it from here rather than from a regex of its own.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stripUncontainable(value) {
  return typeof value === "string" ? value.replace(UNCONTAINABLE, "") : "";
}

/**
 * The value, contained, so nothing in it can reach the app's own words.
 *
 * **A string with nothing to contain comes back byte-identical**, deliberately:
 * almost every path, name and label is ordinary text, and wrapping all of them
 * would put two invisible characters into every comparison, every snapshot and
 * everything somebody copies, to no end. The container appears exactly where
 * there is something to hold.
 *
 * Call it at the point the value is known to be *display* — after any length
 * cap the caller applies, so the cap measures the text rather than the
 * container.
 *
 * @param {unknown} value
 * @returns {string}
 */
function isolateForDisplay(value) {
  const cleaned = stripUncontainable(value).replace(POPS, "");
  if (cleaned === "" || !FORMAT_CHARACTER.test(cleaned)) return cleaned;
  return `${FIRST_STRONG_ISOLATE}${cleaned}${POP_DIRECTIONAL_ISOLATE}`;
}

module.exports = {
  FIRST_STRONG_ISOLATE,
  POP_DIRECTIONAL_ISOLATE,
  POP_DIRECTIONAL_FORMATTING,
  isolateForDisplay,
  stripUncontainable,
};
