import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { parentPath } from "../files/paths";
import { EMPTY_QUERY_SPEC } from "../querySpec";
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
  /** Nothing to do now the places are subscribed; Home still calls it each time it is shown. */
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
 * Held open as subscriptions (phase 2 of the tree's move into Convex): a pin
 * made on the phone, or a recent opened in another tab, reaches every Home
 * that is showing at once. A pin or unpin made here is drawn at once too, and
 * that local answer stands until the server's next answer arrives.
 */
export function useHomePlaces(workspaceId: string | null | undefined, enabled: boolean): HomePlaces {
  const convex = useConvex();
  const ws = enabled && workspaceId != null ? (workspaceId as Id<"workspaces">) : null;
  const spec = useMemo(
    () =>
      ws === null
        ? EMPTY_QUERY_SPEC
        : {
            pins: { query: api.functions.places.listPins, args: { workspaceId: ws } },
            opened: { query: api.functions.places.mostOpened, args: { workspaceId: ws } },
            recents: { query: api.functions.places.recentNotes, args: { workspaceId: ws } },
          },
    [ws],
  );
  const live = useQueries(spec) as Record<string, unknown>;
  // An error (a membership just taken away) draws as nothing, as a missing answer does.
  const answer = <T,>(value: unknown): T | undefined => (value === undefined || value instanceof Error ? undefined : (value as T));
  const livePins = answer<readonly HomePin[]>(live.pins);
  const liveOpened = answer<readonly HomeOpened[]>(live.opened);
  const liveRecents = answer<readonly HomeRecent[]>(live.recents);
  // This person's own pin changes, drawn before the server has answered them.
  const [local, setLocal] = useState<{ ws: string | null; from: unknown; pins: readonly HomePin[] } | null>(null);
  const serverPins = ws === null ? NO_PINS : (livePins ?? NO_PINS);
  const pins = local !== null && local.ws === ws && local.from === livePins ? local.pins : serverPins;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const setPin = useCallback(
    (path: string, kind: "note" | "folder", on: boolean) => {
      if (ws === null) return;
      const without = pinsRef.current.filter((row) => row.path !== path);
      const next = on ? [...without, { path, kind }] : without;
      pinsRef.current = next;
      setLocal({ ws, from: livePins, pins: next });
      void (async () => {
        try {
          if (on) await convex.mutation(api.functions.places.pin, { workspaceId: ws, path, kind });
          else await convex.mutation(api.functions.places.unpin, { workspaceId: ws, path });
        } catch {
          // Refused (the ceiling, a lost membership): the server's answer puts Home back.
          setLocal(null);
        }
      })();
    },
    [convex, ws, livePins],
  );
  const togglePin = useCallback(
    (path: string, kind: "note" | "folder") => setPin(path, kind, !pinsRef.current.some((row) => row.path === path)),
    [setPin],
  );

  // Subscribed, so there is nothing to ask again; kept so Home's call stays harmless.
  const refresh = useCallback(() => {}, []);

  return {
    pins,
    opened: ws === null ? NO_OPENS : (liveOpened ?? NO_OPENS),
    recents: ws === null ? NO_RECENTS : (liveRecents ?? NO_RECENTS),
    refresh,
    togglePin: ws === null ? null : togglePin,
    setPin: ws === null ? null : setPin,
  };
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
