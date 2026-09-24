/**
 * THE OPT-IN SEAM — shape only. Nothing below is wired up, on purpose.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

import { GENERIC_PREVIEW, type PreviewMeta } from "./meta";

/**
 * What an owner would have to switch on, per workspace, before a link to their
 * context unfurled as anything but GENERIC_PREVIEW.
 *
 * THIS FIELD DOES NOT EXIST IN THE CONTROL PLANE YET, and no code path reaches
 * for it. The type is here so the security contract is written down before
 * somebody implements the endpoint, not after.
 *
 * The whole idea is a deliberate, revocable exception to CLAUDE.md §5: `team`
 * never means public, so publishing *any* workspace-derived string to
 * unauthenticated crawlers has to be a decision the owner makes explicitly and
 * can take back. Hence:
 *
 *  - **Default off.** Absent, null, `false`, an unparseable response, an
 *    error, a timeout — every one of them means GENERIC_PREVIEW. There is no
 *    configuration in which silence means "publish".
 *  - **One field, and it is not a name the owner did not choose.** A display
 *    label they typed for this purpose. Not the workspace slug, not the
 *    username, not the owner's real name, and never their email.
 *  - **Nothing quantitative, ever.** No note count, no member count, no folder
 *    names, no size, no last-modified. Those describe the context's contents,
 *    which is precisely what an unauthenticated reader must not learn.
 *  - **No image of their own.** The card stays the product card. A per-
 *    workspace image would leak through the picture what the text withholds,
 *    and would additionally hand every crawler a pixel that says "this
 *    workspace exists".
 */
export interface PublicPreviewProfile {
  /**
   * The owner's chosen public label, 1–60 characters of plain text. Present
   * ONLY when the workspace has previews explicitly enabled.
   */
  readonly displayName: string;
}

/**
 * The metadata an opted-in workspace would get.
 *
 * Pure, so the invariants can be tested without any of the machinery that does
 * not exist yet. Note what it still refuses to do: the canonical URL stays the
 * site root, and the description says nothing beyond "sign in". Opting in buys
 * a label on the card and not one thing more.
 *
 * Whoever wires this up owes the reader two things this file cannot provide:
 *
 *  1. **A negative response that is byte-identical to a positive one's
 *     absence.** "Not enabled", "not found", and "does not exist" must be one
 *     indistinguishable answer, the way
 *     `apps/convex/functions/lib/workspaceAuth.ts` already does it. Returning
 *     404 for an unclaimed name and 200-with-`enabled:false` for a private one
 *     rebuilds the existence oracle in the response status.
 *  2. **Constant time, including on failure.** The current code path has no
 *     upstream call at all, so latency cannot be read. A lookup gives that up;
 *     it needs a fixed timeout and a fallback to GENERIC_PREVIEW that costs the
 *     same whether the name existed or not.
 *
 * Until both hold, do not call this.
 */
export function previewFromProfile(
  profile: PublicPreviewProfile | null | undefined,
): PreviewMeta {
  const displayName = profile?.displayName?.trim();
  if (!displayName) return GENERIC_PREVIEW;

  return {
    ...GENERIC_PREVIEW,
    // Bounded before it is escaped: a 4 KB "display name" should not become a
    // 4 KB og:title, and truncation keeps the response size from varying with
    // anything an attacker controls.
    title: `${displayName.slice(0, 60)} — Context`,
  };
}
