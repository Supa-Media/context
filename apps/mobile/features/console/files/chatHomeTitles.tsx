import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { EMPTY_QUERY_SPEC } from "../querySpec";

/**
 * A group chat's home drawn by its chat's name, or by its people when the chat has none, instead of the three words
 * its folder is called (decided by the owner, 2026-11-02, "Group chat names" artboard). The words stay the folder's
 * name and its path; only what a row, a crumb or a tree line says changes. The control plane answers only the homes
 * the reader is named on, in the pinned workspace (`apps/convex/functions/textGroupNames.ts`).
 */
export interface ChatHomeTitle {
  /** The home's folder, `tex/groups/<words>`. */
  path: string;
  /** What to draw: the chat's name, or `@bo, @cy +2`. */
  title: string;
  /** Whether `title` is the chat's own name rather than its people. */
  named: boolean;
  /** The three words, said beside the title where there is room (a hover, an accessibility hint). */
  words: string;
}

const NONE: ReadonlyMap<string, ChatHomeTitle> = new Map();

/** The context the provider fills; exported for a test to fill it directly. */
export const ChatHomeTitlesContext = createContext<ReadonlyMap<string, ChatHomeTitle>>(NONE);

/** The titles by home path, from a list the control plane answered. A name is drawn isolated, like any name. */
export function titlesByPath(answer: readonly ChatHomeTitle[] | undefined): ReadonlyMap<string, ChatHomeTitle> {
  if (answer === undefined || answer.length === 0) return NONE;
  return new Map(answer.map((home) => [home.path, { ...home, title: isolateForDisplay(home.title) }]));
}

/** `rows` with each chat home's label its title; every other row as it was. */
export function withChatHomeTitles<T extends { path: string; label: string }>(rows: readonly T[], titles: ReadonlyMap<string, ChatHomeTitle>): readonly T[] {
  if (titles.size === 0) return rows;
  return rows.map((row) => {
    const home = titles.get(row.path);
    return home === undefined ? row : { ...row, label: home.title };
  });
}

/**
 * Asks for the open workspace's chat home titles once, for every row below. Nothing for a demo or no workspace.
 * Read with `useQueries`, as the console's own data is: a failed answer is a value here, and the rows keep their
 * three words, where a `useQuery` would re-throw during render and blank the console over a label.
 */
export function ChatHomeTitlesProvider({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  // Primitives only in the memo's dependencies, `api` reached inside it: see `../querySpec.ts`.
  const queries = useMemo<RequestForQueries>(
    () =>
      workspaceId === null
        ? EMPTY_QUERY_SPEC
        : { titles: { query: api.functions.textGroupNames.homeTitles, args: { workspaceId: workspaceId as Id<"workspaces"> } } },
    [workspaceId],
  );
  const result = useQueries(queries).titles as ChatHomeTitle[] | Error | undefined;
  const answer = result instanceof Error ? undefined : result;
  const titles = useMemo(() => titlesByPath(answer), [answer]);
  return <ChatHomeTitlesContext.Provider value={titles}>{children}</ChatHomeTitlesContext.Provider>;
}

/** The open workspace's chat home titles by path; empty outside the console. */
export function useChatHomeTitles(): ReadonlyMap<string, ChatHomeTitle> {
  return useContext(ChatHomeTitlesContext);
}
