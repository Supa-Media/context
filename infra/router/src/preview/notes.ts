/**
 * Readable team-link note previews: `/console/@seyi?note=1-projects/plan.md`.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace, and `shareLinks.ts` for the share-token preview
 * this mirrors.
 */

import { GENERIC_PREVIEW, ORIGIN, type PreviewMeta } from "./meta";
import { decodeSafely, boundTitle } from "./textBounds";
import { normalisePath } from "./meta";
import { shareCardPath } from "./shareLinks";

/**
 * A readable team link: `/console/@seyi?note=1-projects/plan.md`.
 *
 * Returns the handle and the note path, or `null` when the URL is not one.
 * Shape-checked here, before anything is fetched, for the same reason
 * `shareTokenFrom` is: a path that is not a console note link never becomes an
 * upstream request.
 *
 * ## Why this may unfurl at all, when `/@seyi` may not
 *
 * It is guessable, and that normally settles it — the frozen card exists
 * because a nicer preview of a guessable path is an existence oracle. The
 * difference is what the answer is drawn from: the control plane replies only
 * for notes the owner has **explicitly team-linked**, so an unlinked note is
 * byte-identical to one that does not exist. The probe reveals the set the
 * owner already chose to publish a card for.
 *
 * That was the owner's call, made with the unguessable alternative in front of
 * them, on the grounds that a link nobody can read is a link nobody clicks.
 */
export function consoleNoteFrom(url: URL): { slug: string; path: string } | null {
  const segments = normalisePath(url.pathname).split("/").filter(Boolean);
  // `console`, `@slug`, and nothing after it — a settings URL is not a note.
  if (segments.length !== 2 || segments[0] !== "console") return null;

  const handle = decodeSafely(segments[1]);
  if (!handle.startsWith("@")) return null;
  const slug = handle.slice(1);
  // The same shape a name claim can have. Anything else never existed, so it
  // costs no round trip to say so.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;

  const path = url.searchParams.get("note");
  if (path === null || path === "" || path.length > 512) return null;
  // Refused rather than forwarded: a rooted or traversing path is a
  // hand-edited URL, and the honest answer is the frozen card.
  if (path.startsWith("/") || path.includes("\\")) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  // Plumbing, in two rules rather than one — a dot-prefixed segment catches
  // `.history/`, and the exact root key catches `privacy.md`, which has no dot
  // in it at all. Restated from `isPlumbing` in the control plane, which is the
  // authority; this is the cheap refusal that keeps a probe for it from
  // becoming a round trip, and it is deliberately not normalisation: a trailing
  // slash slips past here and is caught there.
  if (path.split("/").some((segment) => segment.startsWith("."))) return null;
  // `scopes.yml` was masked by a note-only rule here and is not any more: that
  // rule is gone, so this is the only thing refusing it and a test now pins it.
  // The note above predicted exactly this — "it becomes load-bearing again the
  // moment that rule is relaxed, which is what a folder preview would require."
  if (path === "privacy.md" || path === "scopes.yml") return null;
  // **And not a name the product itself wrote there.**
  //
  // There was a `.md` test here once, and it was standing in for this one. The
  // question a preview turns on is *guessability*, and file-versus-folder was
  // only ever a proxy for it: a folder was refused because `/@name/1-projects`
  // is five guesses per handle, not because it is a folder.
  //
  // So the names the PRODUCT picks are named. That is more than a fresh workspace's
  // scaffold: `scaffoldFiles` lays down `index.md`, `privacy.md` and a
  // `README.md` per PARA folder and the house rules add a root `todo.md`, but
  // the gateway also creates folders AFTER creation — where `save_context`
  // files a session, and where `writeInboxCapture` files a capture under the
  // sender's own slug, three of which are ours. Everything else in a workspace is a
  // name its owner chose, and `1-projects/chapter-transition` is exactly as
  // unguessable as `1-projects/chapter-transition/overview.md`.
  //
  // This is the control plane's `isProductMandatedPath` restated, and the list
  // is duplicated because this package cannot import from `apps/convex`. It
  // saves the round trip; `previewForNote` is where it is enforced.
  //
  // Note that `privacy.md` in that Set is masked by the explicit plumbing line
  // above and cannot be pinned here: a masked guard should say so rather than
  // let a reader discover it by deleting it.
  if (PRODUCT_MANDATED_PATHS.has(path)) return null;

  return { slug, path };
}

/**
 * Every note path this product writes into a workspace before its owner does.
 *
 * `apps/convex/functions/lib/scaffold.ts` is the source of truth, and exports
 * the list itself as `PRODUCT_MANDATED_PATHS` — `INDEX_KEY`, `PRIVACY_KEY`,
 * `GENERIC_ROOT_KEYS`, the `PARA_FOLDERS` themselves, `SESSION_FOLDERS`, and a
 * `README.md` per PARA folder.
 * This package is a separate deployment and cannot import that module, so the
 * list is restated here.
 *
 * The restatement is checked rather than trusted: `teamShare.test.ts` reads this
 * file, extracts this literal, and asserts it equals what the control plane
 * derives. Drift is not dangerous — the derived copy is authoritative, so a
 * stale list here costs a wasted round trip and never a title — but it would be
 * silent, and silent is how the folder count stayed at five.
 */
export const PRODUCT_MANDATED_PATHS = new Set([
  "index.md",
  "privacy.md",
  "todo.md",
  // Where `save_context` files a session. `defaultSessionFolder` in the gateway
  // picks `<archive>/chat-history` when the manifest declares an archive folder
  // and `0-inbox/sessions` otherwise, so a workspace whose owner has run the
  // hook once has one of them — a guess per handle on names nobody chose.
  // One entry per archive root THIS PRODUCT ships: the PARA scaffold's and the
  // presets'. An archive a customer named is theirs and is not on this list.
  "4-archive/chat-history",
  "5-archive/chat-history",
  "0-inbox/sessions",
  // Capture folders the gateway derives from a capture's `source`.
  // `writeInboxCapture` files an `external_id` capture under
  // `0-inbox/<safeSlug(source)>/`, and three senders are the product's own:
  // the hook's three client ids, the `POST /inbox` default, and Granola.
  "0-inbox/hook-claude-code",
  "0-inbox/hook-codex",
  "0-inbox/hook-gemini-cli",
  "0-inbox/inbox",
  "0-inbox/granola",
  // `safeSlug` falls back to a literal of ours for a source with no Latin
  // alphanumerics, so that folder name is ours rather than the sender's.
  "0-inbox/capture",
  // The single-tenant calendar cron's one hardcoded path, and its folder.
  "2-areas/calendar",
  "2-areas/calendar/next-14-days.md",
  "0-inbox",
  "1-projects",
  "2-areas",
  "3-resources",
  "4-archive",
  "0-inbox/README.md",
  "1-projects/README.md",
  "2-areas/README.md",
  "3-resources/README.md",
  "4-archive/README.md",
  // The workspace presets. `apps/mobile/features/workspace/presets.ts` ships
  // two fixed layouts through the `custom` template path, and `company` is what
  // a shared context gets when nobody chooses — so these are names this product
  // writes, not names an owner picked, and a shared context's scaffold starts
  // them `team` so a card on one really does list its contents.
  "1-clients",
  "2-pipeline",
  "2-teams",
  "3-handbook",
  "3-practice",
  "4-customers",
  "5-archive",
  "1-clients/README.md",
  "2-pipeline/README.md",
  "2-teams/README.md",
  "3-handbook/README.md",
  "3-practice/README.md",
  "4-customers/README.md",
  "5-archive/README.md",
]);

/**
 * The most children a folder's card may name, and the longest one.
 *
 * Mirrors `MAX_PREVIEW_CHILDREN` and `MAX_PREVIEW_CHILD_NAME` in
 * `apps/convex/functions/lib/shareTitle.ts`, and the duplication is the point.
 * The control plane bounds this list where it is written and again where it is
 * read; this bounds it a third time because **an edge that trusts its upstream
 * to have been careful has no bound at all** — the rule `previewForShare`'s own
 * title bound was written down for, applied to the one field on this response
 * that is a list rather than a string.
 */
const MAX_CHILDREN = 3;
const MAX_CHILD_NAME = 40;

/**
 * Whatever the upstream sent, made safe to put in a card.
 *
 * Typed `unknown[]` on purpose: this is parsed JSON off the wire, so "it is an
 * array of strings" is a claim rather than a fact, and a non-string entry that
 * reached `join` would be `[object Object]` on somebody's card. Control
 * characters go for the reason the control plane strips them — a newline inside
 * an `og:description` renders differently in every unfurler and there is
 * nothing to escape it *to*, where `<` is handled correctly by `escapeHtml` on
 * the way out and is tested for.
 */
function boundChildren(children: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(children)) return [];
  const bounded: string[] = [];
  for (const entry of children) {
    if (bounded.length >= MAX_CHILDREN) break;
    if (typeof entry !== "string") continue;
    // `Cf` beside `Cc`: the categories are disjoint, and a bidi override
    // (U+202E and friends) is `Cf`. See `lib/shareTitle.ts` for the argument;
    // the two copies are held by running both, not by this comment.
    const clean = entry.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
    if (clean === "") continue;
    bounded.push(clean.slice(0, MAX_CHILD_NAME));
  }
  return bounded;
}

/**
 * The card a readable team link unfurls with.
 *
 * `previewForShare`'s reasoning applies unchanged — title only, canonical still
 * the site root, `noindex` intact, and an absent title rendering
 * GENERIC_PREVIEW byte for byte so an unlinked note and a revoked one are one
 * answer.
 */
export function previewForNote(
  title: string | null | undefined,
  cardToken?: string | null,
  children?: readonly unknown[] | null,
): PreviewMeta {
  const bounded = boundTitle(title);
  if (bounded === null) return GENERIC_PREVIEW;

  const inside = boundChildren(children);
  return {
    ...GENERIC_PREVIEW,
    title: `${bounded} — Context`,
    description:
      inside.length === 0
        ? "Shared with you on Context. Sign in to read it — plain markdown in a " +
          "bucket its owner controls."
        : `Inside: ${inside.join(" · ")}. Shared with you on Context — sign in to ` +
          "read it.",
    imageUrl:
      cardToken === undefined || cardToken === null
        ? undefined
        : `${ORIGIN}${shareCardPath(cardToken, bounded, inside)}`,
  };
}
