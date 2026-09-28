/**
 * A folder page's agents: the list that applies here (`agents.ts`), laid into
 * every owner search, and the one write that adds a name to it.
 *
 * The search's people come from the server; its agents come from this list,
 * matched against what was typed here, so an agent is a word the workspace
 * chose rather than whatever a connected client registered as.
 */

import { useCallback, useMemo } from "react";
import type { ListNote } from "../listBlock/model";
import { ANY_AGENT, type OwnerSearch } from "../owners";
import { AGENTS_KEY, agentName, agentsHome, folderAgents, parseAgentOwner, withAgent } from "./agents";
import type { FolderNotes } from "./useFolderPage";

export interface FolderAgentOwners {
  readonly list: readonly string[];
  readonly search: OwnerSearch;
  /** Null for somebody who may not change the list, or where it has nowhere to live. */
  readonly addAgent: ((name: string) => Promise<string | null>) | null;
  /** Whether an owner line names one of the agents (anybody's), or any agent. */
  readonly isAgent: (value: string) => boolean;
}

/** The agents in `list` that `query` finds, in the list's order. */
export function matchingAgents(list: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return list.filter((agent) => q === "" || agent.toLowerCase().includes(q));
}

const NO_NOTES: readonly ListNote[] = [];

export function useAgents(loaded: FolderNotes, folder: string, notes: readonly ListNote[] | null, base: OwnerSearch): FolderAgentOwners {
  const all = notes ?? NO_NOTES;
  const { list, note } = useMemo(() => folderAgents(folder, all), [folder, all]);
  const search = useCallback<OwnerSearch>(
    async (query, prefer) => ({ ...(await base(query, prefer)), agents: matchingAgents(list, query) }),
    [base, list],
  );
  const home = useMemo(() => (note !== null ? { target: note, creates: false } : agentsHome(folder, all)), [note, folder, all]);
  const { canEdit, chooseMany } = loaded;
  const addAgent = useCallback(
    async (typed: string): Promise<string | null> => {
      const named = agentName(typed);
      if ("problem" in named) return named.problem;
      if (home === null) return "Agents can’t be added here.";
      // One line, as a person would write it: `agents: Claude, Codex, Cursor`.
      return chooseMany(home.target, [[AGENTS_KEY, withAgent(list, named.name).join(", ")]], home.creates);
    },
    [home, list, chooseMany],
  );
  const isAgent = useCallback(
    (value: string) => value.trim().toLowerCase() === ANY_AGENT || parseAgentOwner(value, list) !== null,
    [list],
  );
  return { list, search, addAgent: canEdit && home !== null ? addAgent : null, isAgent };
}
