/**
 * Link previews (OpenGraph / Twitter cards) for context.lc.
 *
 * WHY THIS EXISTS
 * ---------------
 * The web app is an Expo SPA: `expo export --platform web` emits ONE
 * `index.html` plus a JS bundle. Crawlers do not run JavaScript, so every URL
 * on the domain currently unfurls with whatever static tags that single file
 * happens to carry — the same card for the landing page, the console, and a
 * shared-context link alike. This Worker already fronts the domain, so it is
 * the one place that can answer a crawler with real per-route metadata before
 * the SPA is ever involved.
 *
 * Same shape as togather.nyc's link-preview Worker (see Togather's ADR-009):
 * detect the crawler by User-Agent, serve a small server-rendered HTML head,
 * let humans fall through to the app untouched.
 *
 * THE PART THAT IS DIFFERENT, AND IS THE WHOLE DESIGN
 * ---------------------------------------------------
 * Togather has public communities. Context has no public tier at all —
 * CLAUDE.md §5: visibility is `private` or `team`, and `team` means named
 * people the owner granted access to. A crawler is none of those. It arrives
 * unauthenticated, with no session, no audit trail, and no way to be revoked;
 * anyone sitting in a Slack channel where a link was pasted gets whatever the
 * unfurl reveals.
 *
 * So the rule here is not "fetch less" — it is **fetch nothing**:
 *
 *   Every path that is not one of the handful of public marketing routes in
 *   PREVIEW_ROUTES below renders GENERIC_PREVIEW: one frozen object, one
 *   constant string, byte for byte, whether the name in the URL belongs to a
 *   real workspace, a private one, or nothing at all.
 *
 * That is the same property `apps/convex/functions/lib/workspaceAuth.ts` works
 * so hard for on the control plane — "not a member" must be indistinguishable
 * from "does not exist" — extended to the one surface that has no auth to lean
 * on. It falls out of the construction rather than being checked for: the
 * renderer only ever sees strings from the static table in this file, so the
 * request path, its query, and its headers cannot reach the output at all.
 * There is no upstream call on this code path, which also makes it
 * constant-time by default — response latency cannot be used as the oracle
 * that the response body isn't.
 *
 * If you are ever about to add a `fetch()` here to look a workspace up, stop.
 * That is the bug this comment exists to prevent.
 *
 * @see route.ts for where preview decisions sit in the routing order
 * @see ogCard.ts for the card image, which is likewise workspace-free
 *
 * ── Where the pieces live ───────────────────────────────────────────────────
 *
 * This file is now a facade: every export below is re-exported from
 * `./preview/`, split by responsibility (core metadata and HTML rendering,
 * share links, note previews, short links, the opt-in profile seam, and
 * crawler detection). `PRODUCT_MANDATED_PATHS` stays here as a literal Set —
 * `PRODUCT_MANDATED_PATHS` now lives in `./preview/notes.ts` as a literal Set,
 * next to the two functions that read it. `apps/convex/__tests__/teamShare/
 * folderLink.test.ts` used to read this file's text to extract it; that test
 * has been repointed at `./preview/notes.ts` (same assertion, new path — see
 * this lane's report). Nothing here changes behaviour; it exists so every
 * caller — and every other test — keeps importing from `./preview` unchanged.
 */

export {
  ORIGIN,
  SITE_NAME,
  OG_CARD_PATH,
  GENERIC_PREVIEW,
  normalisePath,
  previewFor,
  escapeHtml,
  renderPreviewHtml,
  type PreviewMeta,
} from "./preview/meta";

export {
  SHARE_PREFIX,
  shareTokenFrom,
  previewForShare,
  SHARE_CARD_PREFIX,
  shareCardPath,
  cardSignature,
  hashTitle,
  shareCardTokenFrom,
} from "./preview/shareLinks";

export { consoleNoteFrom, previewForNote, PRODUCT_MANDATED_PATHS } from "./preview/notes";

export {
  shortLinkFrom,
  previewForShortLink,
  SHORT_CARD_PREFIX,
  shortLinkCardPath,
  shortLinkCardFrom,
} from "./preview/shortLinks";

export { type PublicPreviewProfile, previewFromProfile } from "./preview/profile";

export { isCrawler } from "./preview/crawlers";
