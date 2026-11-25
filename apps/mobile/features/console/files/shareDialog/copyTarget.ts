/**
 * Which link a plain "Copy link" puts on the clipboard for one note.
 *
 * The link that works for whoever it is sent to: the note's own unlisted
 * link (`/s/<token>`) when it has one, which opens without signing in, and
 * the workspace link otherwise, which only members can open. A note set to
 * "Anyone with the link" whose ⋯ menu copied the workspace link sent its
 * reader to a sign-in page (Dev2, 2026-11-25).
 *
 * Minting the "link" target reuses the active token (`createLinkShare`
 * supersedes in place), so this never makes a second link. "Copy workspace
 * link" in the share sheet's More menu asks for `team` by name and does not
 * come through here.
 */
export function copyTargetFor(
  path: string,
  openLinkPaths: ReadonlySet<string>,
): { kind: "team"; path: string } | { kind: "link"; path: string } {
  return openLinkPaths.has(path) ? { kind: "link", path } : { kind: "team", path };
}
