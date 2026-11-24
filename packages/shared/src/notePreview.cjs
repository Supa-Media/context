/**
 * NOTE LINK PREVIEWS: what a note link Tex texts unfurls with
 * (Dev, 2026-11-23; `docs/decisions/privacy-and-sharing/note-link-previews.md`).
 *
 * A note link (`/note/@slug/<path>`, `/p/@slug/<page>`) used to unfurl as one
 * frozen card, "A note in Context", whatever it named: the address is
 * guessable, so a card drawn from it would tell a stranger what a private
 * note is called. Dev chose a key instead: Tex adds the note's name and a key
 * to the links it texts,
 *
 *   /note/@seyi/areas/spirit/1-timothy-1.md?t=1%20Timothy%201&k=<22 chars>
 *
 * and only a link whose key matches gets a card with that name on it. The key
 * is an HMAC over the workspace, the path and the name, under a key derived
 * from the gateway's secret, so nobody can make a context.lc card say
 * something Tex did not text. It grants nothing: opening the link is still a
 * sign-in and the app's own permission check.
 *
 * Shared by the three places that touch it: the gateway that signs (Tex's
 * `noteLinks.js`), the control plane that checks a key and draws the card
 * (`apps/convex/functions/lib/publicRoutes/noteLinkCards.ts`), and nothing in between: the
 * router only forwards what the crawler asked for.
 *
 * Also here: what the card shows beside the name, all of it read off the link
 * and nothing else. The folder line is the link's own folders, the backdrop is
 * picked from the address, and Tex's pose from the name and the folders.
 */

/** Separates the key's version from what it signs; a new version is a new label. */
const LABEL = "context.note-preview.v1";
/** 16 bytes of the HMAC, as 22 base64url characters. */
const KEY_BYTES = 16;
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** The longest name a link carries and a card draws. */
const MAX_TITLE = 80;

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The HMAC key a deployment signs and checks with, derived from its gateway secret; null without one. */
async function previewSigningKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) return null;
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, encoder.encode(LABEL)));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** What a key signs: one line each, the workspace lowercased, so `@Seyi` and `@seyi` are one link. */
function signedText(slug, path, title) {
  return `${LABEL}\n${String(slug).toLowerCase()}\n${path}\n${title}`;
}

/** The key for one link, from a key `previewSigningKey` made. */
async function previewKey(signingKey, { slug, path, title }) {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(signedText(slug, path, title))));
  return toBase64Url(mac.slice(0, KEY_BYTES));
}

/**
 * Whether `key` is the one this deployment would have made for the link.
 * Compared in constant time over the whole string; any malformed input is false.
 */
async function isPreviewKey(signingKey, { slug, path, title, key }) {
  if (signingKey === null || typeof key !== "string" || !KEY_PATTERN.test(key)) return false;
  if (typeof slug !== "string" || typeof path !== "string" || typeof title !== "string") return false;
  if (cleanTitle(title) !== title) return false;
  const expected = await previewKey(signingKey, { slug, path, title });
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected.charCodeAt(i) ^ key.charCodeAt(i);
  return difference === 0;
}

/** A name fit for a card: control and format characters gone, spaces collapsed, at most MAX_TITLE characters. "" when nothing is left. */
function cleanTitle(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, MAX_TITLE).join("").trim();
}

const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/**
 * A file or folder name read as words: no extension, dashes and underscores as
 * spaces, first letter capital. A folder also loses a PARA number (`1-projects`);
 * a note keeps its own (`1-timothy-1.md` is "1 Timothy 1").
 */
function humanize(name, { folder = false } = {}) {
  const bare = String(name)
    .replace(/\.page\.md$/i, "")
    .replace(/\.md$/i, "")
    .replace(folder ? /^\d+[-_ ]+(?=\D)/ : /$^/, "");
  // A folder, and a name with spaces, read as a sentence; a dashed note name as a title, each word capitalised but the small ones.
  if (/\s/.test(bare) || folder) {
    const spaced = folder ? bare.replace(/[-_]+/g, " ") : bare;
    const trimmed = spaced.replace(/\s+/g, " ").trim();
    return trimmed === "" ? "" : trimmed[0].toUpperCase() + trimmed.slice(1);
  }
  return bare
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * The note's name for its card: its first `# ` heading when `text` (the note's
 * Markdown, front matter allowed) has one near the top, else its file name as
 * words. "" when neither gives one.
 */
function noteTitleOf(path, text) {
  if (typeof text === "string") {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body.split("\n").slice(0, 40).join("\n"));
    const named = heading ? cleanTitle(heading[1].replace(/[*_`]/g, "")) : "";
    if (named !== "") return named;
  }
  const leaf = String(path ?? "").split("/").filter(Boolean).pop() ?? "";
  return cleanTitle(humanize(leaf));
}

/** The card's folder line: the note's last two folders as words, joined by a middle dot. "" for a note at the top. */
function folderLineOf(path) {
  const folders = String(path ?? "").split("/").filter(Boolean).slice(0, -1).slice(-2);
  return cleanTitle(folders.map((name) => humanize(name, { folder: true })).filter(Boolean).join(" · "));
}

/**
 * The backdrops a card is drawn on, in the order a link's address picks them:
 * round 3's notebook page and ink, then the graph page's five boards
 * (`apps/mobile/features/design/tokens/colors.ts` `boardColors`).
 */
const BOARDS = Object.freeze(["notebook", "ink", "paper", "graph", "kraft", "chalk", "blueprint"]);

/** One backdrop per note, from its address, so the same link always looks the same and a chat of links varies. */
function boardOf(slug, path) {
  let hash = 0x811c9dc5;
  for (const char of `${String(slug).toLowerCase()}/${path}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return BOARDS[hash % BOARDS.length];
}

/**
 * What Tex is doing on a card, from words in the note's name and folders, or
 * null for no Tex at all (the card then shows the # icon). Tex appears only
 * when a note plainly is one of these (Dev, 2026-11-23: "smaller and didn't
 * appear on every preview card"). Earlier rules win.
 */
const POSE_RULES = [
  ["checklist", /\b(to-?dos?|checklists?|packing|tasks?|lists?)\b/i],
  ["money", /\b(budgets?|financ\w*|invoices?|receipts?|expenses?|tax(es)?|money|payments?|salary|bills?)\b/i],
  ["cooking", /\b(recipes?|meals?|grocer\w*|dinners?|cook\w*)\b/i],
  ["trip", /\b(trips?|travel\w*|flights?|itinerar\w*|vacations?|holidays?)\b/i],
  ["calendar", /\b(events?|offsites?|schedules?|calendar|deadlines?|retreats?|conferences?|weddings?|birthdays?|party|parties)\b/i],
  ["coffee", /\b(meetings?|catch[- ]?ups?|one[- ]on[- ]ones?|1:1s?|calls? with|standups?|syncs?)\b/i],
  ["reading", /\b(bible|scripture|psalms?|proverbs|gospel|genesis|exodus|romans|timothy|sermons?|devotionals?|books?|reading|study)\b/i],
  ["idea", /\b(ideas?|brainstorm\w*|concepts?|pitch(es)?)\b/i],
  ["painting", /\b(designs?|websites?|mock-?ups?|logos?|brand)\b/i],
  ["waving", /\b(contacts?|people|intros?|introductions?)\b/i],
];

function poseOf(title, path) {
  const words = `${title ?? ""} ${String(path ?? "").replace(/[-_/]+/g, " ")}`;
  for (const [pose, pattern] of POSE_RULES) if (pattern.test(words)) return pose;
  if (/\.page\.md$/i.test(String(path ?? ""))) return "painting";
  return null;
}

/**
 * `text` with each plain note link Tex was given this turn swapped for its
 * signed one. `signed` maps a link exactly as the tool result gave it to the
 * link with `t` and `k`; a link is swapped only where it stands whole (not as
 * the start of a longer address), and every other word is left as it was.
 */
function withPreviewLinks(text, signed) {
  if (typeof text !== "string" || !(signed instanceof Map) || signed.size === 0) return text;
  let out = text;
  for (const [plain, withKey] of signed) {
    let from = 0;
    for (;;) {
      const at = out.indexOf(plain, from);
      if (at === -1) break;
      const next = out[at + plain.length];
      if (next !== undefined && !/[\s)\]>.,;:!?'"]/.test(next)) {
        from = at + plain.length;
        continue;
      }
      out = out.slice(0, at) + withKey + out.slice(at + plain.length);
      from = at + withKey.length;
    }
  }
  return out;
}

module.exports = {
  BOARDS,
  KEY_PATTERN,
  MAX_TITLE,
  boardOf,
  cleanTitle,
  folderLineOf,
  isPreviewKey,
  noteTitleOf,
  poseOf,
  previewKey,
  previewSigningKey,
  withPreviewLinks,
};
