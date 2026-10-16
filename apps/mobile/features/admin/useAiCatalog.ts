/**
 * The AI tab's data: `@context-lc`'s `ai/` folder, read from the tree's front
 * matter with `folderNotes`, every page of it.
 *
 * Gated twice, and neither gate is the staff list: the page draws only for
 * somebody who can edit `@context-lc` (owner or editor there, the people who
 * can write `ai/`), and `folderNotes` itself answers only what that caller's
 * clearance can see. A pinned reader (every account is a `member` of
 * `@context-lc`) is told the page is not theirs and nothing is asked for.
 */

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { AI_FOLDER, buildCatalog, type AiCatalog, type FolderNote } from "./aiCatalog";

/** Enough for hundreds of skills, and a stop if a cursor never ends. */
const MAX_PAGES = 40;

export type AiCatalogState =
  | { kind: "loading" }
  | { kind: "notEditor" }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; catalog: AiCatalog; missing: number; truncated: boolean };

export function canEditAi(role: string | undefined): boolean {
  return role === "owner" || role === "editor";
}

export function useAiCatalog(): { state: AiCatalogState; reload: () => void } {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const folderNotes = useAction(api.functions.folderNotes.folderNotes);
  const [state, setState] = useState<AiCatalogState>({ kind: "loading" });
  const [round, setRound] = useState(0);
  const target = workspaces?.find((workspace) => workspace.slug === PINNED_CONTEXT_SLUG);
  const workspaceId = target && canEditAi(target.role) ? target.workspaceId : null;
  const listed = workspaces !== undefined;

  useEffect(() => {
    if (!listed) return;
    if (workspaceId === null) {
      setState({ kind: "notEditor" });
      return;
    }
    let live = true;
    setState((was) => (was.kind === "ready" ? was : { kind: "loading" }));
    void (async () => {
      try {
        const notes: FolderNote[] = [];
        let missing = 0;
        let cursor: string | undefined;
        let truncated = false;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const answer = await folderNotes({
            workspaceId: workspaceId as Id<"workspaces">,
            folder: AI_FOLDER,
            subfolders: true,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (!answer.available) {
            if (live) setState({ kind: "unavailable" });
            return;
          }
          notes.push(...answer.notes);
          missing += answer.missing.length;
          if (answer.cursor === null) break;
          cursor = answer.cursor;
          truncated = page === MAX_PAGES - 1;
        }
        if (live) setState({ kind: "ready", catalog: buildCatalog(notes), missing, truncated });
      } catch (error: unknown) {
        if (live) setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [listed, workspaceId, folderNotes, round]);

  return { state, reload: () => setRound((was) => was + 1) };
}
