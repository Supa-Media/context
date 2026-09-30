import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { parentPath } from "../files/paths";
import type { HomeOpened, HomePin } from "./homeModel";

const NO_PINS: readonly HomePin[] = [];
const NO_OPENS: readonly HomeOpened[] = [];

export interface HomePlaces {
  pins: readonly HomePin[];
  opened: readonly HomeOpened[];
  /** `null` where there is no account to pin to: a visitor, or no workspace. */
  togglePin: ((path: string, kind: "note" | "folder") => void) | null;
}

/**
 * The signed-in person's own pins and most-opened folders in one workspace,
 * saved on their account (`functions/places.ts`) so every device shows the
 * same Home. `enabled` is false for a visitor on the homepage and for a
 * workspace the console has no role in; nothing is asked for then.
 *
 * Read once each time Home is shown rather than held open as a
 * subscription: nothing but this person changes them, and this hook is where
 * they change them, so it updates its own copy at once and reads the
 * server's back after.
 */
export function useHomePlaces(workspaceId: string | null | undefined, enabled: boolean): HomePlaces {
  const convex = useConvex();
  const ws = enabled && workspaceId != null ? (workspaceId as Id<"workspaces">) : null;
  const [pins, setPins] = useState<readonly HomePin[]>(NO_PINS);
  const [opened, setOpened] = useState<readonly HomeOpened[]>(NO_OPENS);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (ws === null) {
      setPins(NO_PINS);
      setOpened(NO_OPENS);
      return;
    }
    try {
      const [nextPins, nextOpened] = await Promise.all([
        convex.query(api.functions.places.listPins, { workspaceId: ws }),
        convex.query(api.functions.places.mostOpened, { workspaceId: ws }),
      ]);
      // A newer read, or another workspace, has started since: this answer is stale.
      if (mine !== generation.current) return;
      setPins(nextPins ?? NO_PINS);
      setOpened(nextOpened ?? NO_OPENS);
    } catch {
      // Home without pins is still Home; the next visit asks again.
    }
  }, [convex, ws]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePin = useCallback(
    (path: string, kind: "note" | "folder") => {
      if (ws === null) return;
      const pinned = pins.some((row) => row.path === path);
      setPins(pinned ? pins.filter((row) => row.path !== path) : [...pins, { path, kind }]);
      void (async () => {
        try {
          if (pinned) await convex.mutation(api.functions.places.unpin, { workspaceId: ws, path });
          else await convex.mutation(api.functions.places.pin, { workspaceId: ws, path, kind });
        } catch {
          // Refused (the ceiling, a lost membership): the read below puts Home back.
        }
        await load();
      })();
    },
    [convex, ws, pins, load],
  );

  return { pins, opened, togglePin: ws === null ? null : togglePin };
}

/**
 * Count one open of the folder on screen — or of the folder a note is in —
 * for You open most. Once per arrival: staying on a page, or a redraw of it,
 * is not another open.
 */
export function useRecordOpen(
  workspaceId: string | null | undefined,
  enabled: boolean,
  opened: { path: string; kind: "file" | "folder" } | null,
): void {
  const convex = useConvex();
  const last = useRef<string | null>(null);
  const folder = opened === null ? null : opened.kind === "folder" ? opened.path : parentPath(opened.path);
  useEffect(() => {
    // Nothing to count yet (still settling, a visitor): wait, without spending the arrival.
    if (!enabled) return;
    const key = workspaceId == null || folder === null ? null : `${workspaceId}\u001f${folder}`;
    if (key === last.current) return;
    last.current = key;
    // The workspace's own page is Home itself, not a folder somebody opens.
    if (workspaceId == null || folder === null || folder === "") return;
    void (async () => {
      try {
        await convex.mutation(api.functions.places.recordOpen, {
          workspaceId: workspaceId as Id<"workspaces">,
          path: folder,
        });
      } catch {
        // A count is a convenience; an open that was not counted changes nothing on screen.
      }
    })();
  }, [convex, enabled, workspaceId, folder]);
}
