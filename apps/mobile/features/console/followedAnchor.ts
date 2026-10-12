/**
 * The anchor a followed link carried, for the note it was followed to.
 *
 * A link like `[[day#msg-…|label]]` — every contact page's activity line —
 * names a place inside a note. `ConsoleNav.follow` opens the note through the
 * same `select` a row tap uses (so tabs and the unsaved-draft guard behave
 * exactly as for any link), and `select` has no way to carry an anchor; the
 * URL it writes back is the plain `?note=path`. So the anchor is held beside
 * the selection, keyed by the path it belongs to, and read back here: the
 * address's own anchor (`?note=path#anchor`, a deep link) wins, and a followed
 * one only counts while its note is the one on screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NoteLinkOpen } from "./files/noteLinks";

export interface FollowedAnchor {
  path: string;
  anchor: string;
}

/**
 * A `follow` that remembers the anchor it was handed, and the anchor itself.
 *
 * Forgotten once its note has been on screen and something else is — so
 * going back to that note later by the tree does not scroll it again — or
 * when the next link is followed. Not on "the selection is not that note
 * yet": an open is a read away, and the selection moves only when it lands.
 */
export function useFollowedAnchor(
  open: (path: string, mode: NoteLinkOpen) => void,
  files: { selectedPath: string | null },
): {
  follow: (path: string, mode: NoteLinkOpen, anchor?: string) => void;
  followed: FollowedAnchor | null;
} {
  const [followed, setFollowed] = useState<(FollowedAnchor & { arrived: boolean }) | null>(null);
  const follow = useCallback(
    (path: string, mode: NoteLinkOpen, anchor?: string) => {
      if (mode === "foreground") setFollowed(anchor ? { path, anchor, arrived: false } : null);
      open(path, mode);
    },
    [open],
  );
  const { selectedPath } = files;
  useEffect(() => {
    if (followed === null) return;
    if (selectedPath === followed.path) {
      if (!followed.arrived) setFollowed({ ...followed, arrived: true });
    } else if (followed.arrived) {
      setFollowed(null);
    }
  }, [followed, selectedPath]);
  const path = followed?.path ?? null;
  const anchor = followed?.anchor ?? null;
  const shown = useMemo(
    () => (path === null || anchor === null ? null : { path, anchor }),
    [path, anchor],
  );
  return { follow, followed: shown };
}

/** The anchor the note on screen should scroll to, or `null`. */
export function anchorOnScreen(
  selectedPath: string | null,
  addressAnchor: string | null,
  followed: FollowedAnchor | null,
): string | null {
  if (addressAnchor !== null) return addressAnchor;
  if (followed === null || selectedPath === null || followed.path !== selectedPath) return null;
  return followed.anchor;
}
