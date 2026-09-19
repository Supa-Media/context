/**
 * What a workspace may put in its mark, and the rules both sides must agree on.
 *
 * ## The problem this exists for
 *
 * `WorkspaceMark` draws one letter, derived from the slug. That is a fine
 * default and it stops distinguishing the moment somebody has two contexts
 * whose names start alike: `@seyi` and `@supa` are both **S**, drawn in the
 * same square, in the same colour, side by side in the rail. The letter is not
 * wrong — it is simply not an identity, and a switcher is a control whose
 * entire purpose is identity.
 *
 * ## Two kinds, and why not one
 *
 * A **photo** is the answer for a context that has a face somewhere already —
 * a team, a client, a project with a logo. A single **emoji** is the answer for
 * one that does not, and it is the one most people reach for: it costs a tap,
 * it needs no file, and at 18pt a 🧠 and a 🏗 are further apart than any two
 * letters can be.
 *
 * They are a union rather than two fields because a mark shows one thing. Two
 * optional fields would make "photo set, emoji also set" representable, and
 * then every drawing site would need its own tie-break — which is how two
 * surfaces end up disagreeing about what a workspace looks like.
 *
 * Absent is the third state and it is the default: no icon means the letter,
 * exactly as before. Nothing here is a migration.
 *
 * ## Where the bytes live
 *
 * A photo is **content**, so it lives in the workspace's own bucket, in the
 * opaque image store the paste path already writes to, and the control plane
 * records only the leaf — never the bytes (`CLAUDE.md` #1). An emoji is not
 * content; it is a label, a handful of code points, and it sits on the
 * workspace row beside `displayName` where every reader of the row already is.
 */

/** A workspace's chosen mark, or `undefined` for the letter. */
export type WorkspaceIcon =
  | { kind: "photo"; leaf: string }
  | { kind: "emoji"; emoji: string };

/**
 * The image types a workspace icon may be stored as.
 *
 * **Narrower than the image store's own list, on purpose.** `writeImage`
 * accepts `gif`, `heic` and `heif` as well, and each is wrong here for its own
 * reason: a `gif` is the only one that can move, and an avatar that animates in
 * a settings rail is a decision nobody asked for; `heic`/`heif` are what an
 * iPhone holds a photo as and what **no browser draws**, so a mark chosen on a
 * phone would be a blank square on the web app — a picker that silently
 * produces an invisible result. The photo picker asks for `jpeg` and gets it,
 * on both platforms.
 *
 * SVG is absent here for the reason it is absent from the store: it is a script
 * container. That refusal is the store's and this list does not relax it.
 */
export const WORKSPACE_ICON_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/**
 * The same rule as a set, for callers that only ask "may I send this".
 *
 * Derived rather than written out again. The control plane needs the extension
 * — it names the object in the bucket — and the picker needs only membership,
 * and those were briefly two literals in two packages, which is the drift this
 * module exists to prevent.
 */
export const WORKSPACE_ICON_CONTENT_TYPES: ReadonlySet<string> = new Set(
  WORKSPACE_ICON_EXTENSIONS.keys(),
);

/**
 * The most a workspace icon may weigh.
 *
 * A fifth of what the image store allows a pasted image, and the difference is
 * the point: a paste is a picture somebody wants to *look at*, and this is an
 * 18pt square that the rail draws once per workspace per paint. The console
 * shows a mark for every context a person can reach, so the cost of a generous
 * cap here is paid on every load, several times over, by somebody who never
 * asked to see a photograph.
 *
 * One mebibyte is far more than a square avatar needs and is still small enough
 * that a context list cannot become a download. The picker crops square and
 * compresses before it ever gets here; this is the backstop for a caller that
 * is not the picker.
 */
export const WORKSPACE_ICON_MAX_BYTES = 1_048_576;

/**
 * The longest an emoji may be, in UTF-16 code units.
 *
 * A bound rather than a guess at the longest real sequence: the family-of-four
 * emoji with skin tones is 25 units, and a flag of a subdivision is 14. What
 * this actually refuses is the shape the validator below cannot — a caller
 * chaining a hundred zero-width joins into one "grapheme" and storing a
 * kilobyte in a field every workspace row carries.
 */
export const WORKSPACE_ICON_MAX_EMOJI_LENGTH = 32;

/**
 * Is this exactly one emoji?
 *
 * ## Why this is not `value.length <= 2`
 *
 * The field is drawn in an 18pt square, so "one glyph" is a layout constraint
 * before it is anything else, and the obvious spellings of it are all wrong. A
 * code-unit count admits `ab`. A code-point count admits a ZWJ sequence's first
 * element only. And a field that takes arbitrary text takes a right-to-left
 * override, a combining-character stack that draws over the row above it, or
 * two hundred characters that reflow the whole settings panel — in a value that
 * is shown to **every member of the workspace**, which makes it somebody else's
 * screen the owner is typing into.
 *
 * So the rule is structural: one emoji *unit*, optionally joined to more by
 * zero-width joiners, and nothing else in the string. A letter, a digit, a
 * space, a combining accent and an RTL override all fail it, because none of
 * them is an emoji unit.
 *
 * ## The four units
 *
 * A country flag is a **pair** of regional indicators (🇬🇧 is two code points,
 * neither of which is a flag). A subdivision flag is a black flag followed by
 * tag characters and a terminator (🏴󠁧󠁢󠁷󠁬󠁳󠁿). A keycap is a digit, `#` or `*`,
 * then an optional variation selector, then U+20E3 — the one case where an
 * ASCII character legitimately starts an emoji. Everything else is a
 * pictographic base plus any variation selectors and skin-tone modifiers.
 *
 * ## The regex is built here, not at module load
 *
 * Deliberate: this module is imported by the mobile app for its emoji list, and
 * Unicode property escapes are an engine feature. `\p{L}` is already shipped in
 * `WorkspaceMark`, so the app's runtime has them — but a property that is
 * *missing* is a **parse** error, which at module scope is a blank app rather
 * than a validator that says no. Built inside the call, a hostile runtime costs
 * one refused emoji, and the server — which is where this answer is
 * authoritative — is V8 and has never been in doubt.
 */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > WORKSPACE_ICON_MAX_EMOJI_LENGTH) {
    return false;
  }
  let pattern: RegExp;
  try {
    /* A pictographic base, plus the modifiers that decorate it in place. */
    const pictographic = "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*";
    /* Two regional indicators, and exactly two: 🇬 alone is not a flag. */
    const flag = "[\\u{1F1E6}-\\u{1F1FF}]{2}";
    /* 🏴 followed by tag characters and the cancel tag. */
    const subdivision = "\\p{Extended_Pictographic}[\\u{E0020}-\\u{E007E}]+\\u{E007F}";
    /* The one unit that may start with an ASCII character. */
    const keycap = "[0-9#*]\\uFE0F?\\u20E3";
    const unit = `(?:${subdivision}|${flag}|${keycap}|${pictographic})`;
    /* Units joined by ZWJ, anchored so nothing may ride along beside them. */
    pattern = new RegExp(`^${unit}(?:\\u200D${unit})*$`, "u");
  } catch {
    return false;
  }
  return pattern.test(value);
}

/**
 * The emoji the picker offers.
 *
 * A curated list rather than a system keyboard, for one reason that is about
 * the product and one that is about the platform. The product reason: the
 * question being asked is "which of my contexts is this", and a grid somebody
 * can scan in a second answers it better than a search box over four thousand
 * glyphs. The platform reason: React Native has no emoji picker, the OS
 * keyboard is unavailable on web, and a free-text field is how you get an RTL
 * override in a field the whole workspace sees.
 *
 * Chosen to be the things people actually name a context after — work, a
 * client, a place, a subject, a hobby — and to stay distinguishable at 18pt,
 * which rules out most of the faces: 😀 and 😃 are the same yellow disc at this
 * size, and a mark that needs to be looked at twice is the letter again.
 *
 * Anything `isSingleEmoji` accepts is storable, so this list is the picker's
 * offer and never the API's rule. Growing it is a copy change.
 */
export const WORKSPACE_ICON_EMOJI: readonly string[] = [
  "🧠", "💡", "📓", "📚", "🗂", "📌", "🔖", "✏️",
  "🏗", "🛠", "⚙️", "🧩", "🔬", "🧪", "🚀", "🛰",
  "💼", "🏢", "🏦", "📈", "💰", "🧾", "⚖️", "🔑",
  "🏠", "🌍", "✈️", "🗺", "🏝", "🏔", "🌲", "🌱",
  "⛪", "🎓", "🎵", "🎨", "🎬", "📷", "🎮", "⚽",
  "🍳", "☕", "🐈", "🐕", "❤️", "⭐", "🔥", "🌙",
];
