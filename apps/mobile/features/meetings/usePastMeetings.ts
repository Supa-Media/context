import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import { tableListNotes, type ServerListIO } from "../offline/serverLists";
import { meetingsFromNotes, type PastMeeting } from "./pastMeetings";

/**
 * The meeting notes in the workspaces the panel names, read from the server's
 * parsed front matter (`folderNotes`, one query a page, never a note body),
 * so a meeting filed from any device is listed.
 *
 * Kept in memory per workspace and asked again at most every
 * `PAST_REFRESH_MS`, so switching tabs or notes redraws at once instead of
 * scanning the tree each time. `null` until the first answer.
 */

export interface PastWorkspace {
  readonly id: string;
  readonly slug: string;
}

export const PAST_REFRESH_MS = 60_000;

const cache = new Map<string, { at: number; meetings: PastMeeting[] }>();

export function usePastMeetings(workspaces: readonly PastWorkspace[]): PastMeeting[] | null {
  const convex = useConvex();
  const key = workspaces.map((w) => `${w.id}:${w.slug}`).join(",");
  const cached = (): PastMeeting[] | null => {
    const parts = workspaces.map((w) => cache.get(w.id)?.meetings);
    return parts.every((part) => part !== undefined) ? parts.flatMap((part) => part ?? []) : null;
  };
  const [meetings, setMeetings] = useState<PastMeeting[] | null>(cached);

  useEffect(() => {
    let alive = true;
    setMeetings(cached());
    const now = Date.now();
    void Promise.all(
      workspaces.map(async (workspace) => {
        const held = cache.get(workspace.id);
        if (held !== undefined && now - held.at < PAST_REFRESH_MS) return held.meetings;
        const io: ServerListIO = {
          readNotes: async () => [],
          folderNotes: (folder, subfolders, cursor) =>
            convex.action(api.functions.folderNotes.folderNotes, {
              workspaceId: workspace.id as Id<"workspaces">,
              folder,
              subfolders,
              ...(cursor === undefined ? {} : { cursor }),
            }),
        };
        try {
          const listed = await tableListNotes(io, "", true);
          const found = meetingsFromNotes(listed.notes, workspace);
          cache.set(workspace.id, { at: Date.now(), meetings: found });
          return found;
        } catch {
          // Offline or refused: what was held, or nothing, never a guess.
          return held?.meetings ?? [];
        }
      }),
    ).then((parts) => {
      if (alive) setMeetings(parts.flat());
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, key]);

  return meetings;
}
