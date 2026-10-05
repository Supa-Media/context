import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { parentPath } from "../files/paths";
import type { HomeOpened, HomePin, HomeRecent } from "./homeModel";

const NO_PINS: readonly HomePin[] = [];
const NO_OPENS: readonly HomeOpened[] = [];
const NO_RECENTS: readonly HomeRecent[] = [];
/** A note kept open and typed in counts again at most this often. */
export const RECENT_EDIT_EVERY_MS = 60_000;

export interface HomePlaces {
  pins: readonly HomePin[];
  opened: readonly HomeOpened[];
  /** The notes this person opened or edited last, newest first. */
  recents: readonly HomeRecent[];
  /** Ask the server again: Home calls it each time it is shown. */
  refresh: () => void;
  /** `null` where there is no account to pin to: a visitor, or no workspace. */
  togglePin: ((path: string, kind: "note" | "folder") => void) | null;
  /**
   * Pin (`on`) or unpin one path, whatever it is now. What several rows and
   * an Undo need (board 16): a toggle closes over the pins of the render it
   * came from, so a second one before the next render flips the wrong way.
   */
  setPin: ((path: string, kind: "note" | "folder", on: boolean) => void) | null;
}

/**
 * The signed-in person's own pins, most-opened folders and recent notes in one workspace,
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
  const [recents, setRecents] = useState<readonly HomeRecent[]>(NO_RECENTS);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (ws === null) {
      setPins(NO_PINS);
      setOpened(NO_OPENS);
      setRecents(NO_RECENTS);
      return;
    }
    try {
      const [nextPins, nextOpened, nextRecents] = await Promise.all([
        convex.query(api.functions.places.listPins, { workspaceId: ws }),
        convex.query(api.functions.places.mostOpened, { workspaceId: ws }),
        convex.query(api.functions.places.recentNotes, { workspaceId: ws }),
      ]);
      // A newer read, or another workspace, has started since: this answer is stale.
      if (mine !== generation.current) return;
      setPins(nextPins ?? NO_PINS);
      setOpened(nextOpened ?? NO_OPENS);
      setRecents(nextRecents ?? NO_RECENTS);
    } catch {
      // Home without pins is still Home; the next visit asks again.
    }
  }, [convex, ws]);

  useEffect(() => {
    void load();
  }, [load]);

  const setPin = useCallback(
    (path: string, kind: "note" | "folder", on: boolean) => {
      if (ws === null) return;
      setPins((current) => {
        const without = current.filter((row) => row.path !== path);
        return on ? [...without, { path, kind }] : without;
      });
      void (async () => {
        try {
          if (on) await convex.mutation(api.functions.places.pin, { workspaceId: ws, path, kind });
          else await convex.mutation(api.functions.places.unpin, { workspaceId: ws, path });
        } catch {
          // Refused (the ceiling, a lost membership): the read below puts Home back.
        }
        await load();
      })();
    },
    [convex, ws, load],
  );
  const togglePin = useCallback(
    (path: string, kind: "note" | "folder") => setPin(path, kind, !pins.some((row) => row.path === path)),
    [setPin, pins],
  );

  const refresh = useCallback(() => void load(), [load]);

  return { pins, opened, recents, refresh, togglePin: ws === null ? null : togglePin, setPin: ws === null ? null : setPin };
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

/**
 * Put the open note at the top of this person's Recent: when it is opened,
 * and again while they type in it (at most once a minute). Every layout
 * counts, so a note written on a laptop is in Recent on the phone. Somebody
 * else changing a note never moves it here — that is the whole point of
 * Recent (owner, 2026-10-05: "the notes that I've personally recently
 * opened/edited").
 */
export function useRecordRecent(
  workspaceId: string | null | undefined,
  enabled: boolean,
  notePath: string | null,
  /** The unsaved text while they type, `null` when nothing is unsaved: each change may count. */
  typed: string | null,
): void {
  const convex = useConvex();
  const last = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!enabled || workspaceId == null || notePath === null) return;
    const key = `${workspaceId}\u001f${notePath}`;
    const now = Date.now();
    const previous = last.current;
    // Arriving counts at once; staying counts again only for typing, once a minute.
    if (previous !== null && previous.key === key && (typed === null || now - previous.at < RECENT_EDIT_EVERY_MS)) return;
    last.current = { key, at: now };
    void (async () => {
      try {
        await convex.mutation(api.functions.places.recordRecent, {
          workspaceId: workspaceId as Id<"workspaces">,
          path: notePath,
        });
      } catch {
        // Recent is a convenience; a note that was not recorded changes nothing on screen.
      }
    })();
  }, [convex, enabled, workspaceId, notePath, typed]);
}
