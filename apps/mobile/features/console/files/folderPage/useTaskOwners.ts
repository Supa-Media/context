/**
 * Who the owner lines on a project page are, for the List's faces and its
 * Show filter: whether one is the viewer (or the viewer's own agent), whether
 * one is an AI helper, and how each is shown.
 *
 * The viewer is known by the words the host hands over (`FolderPageHost.me`:
 * their name and address). Owner lines are written as handles (`@seyi`), so
 * those words are passed through the same resolve the page already makes for
 * owners written before handles (`useOwnerLabels`), and an owner line is the
 * viewer when it or its label matches either.
 */

import { useCallback, useMemo } from "react";
import type { Face } from "./Glyphs";
import { parseAgentOwner } from "./agents";
import type { OwnerWho } from "./showFilter";

const fold = (text: string) => text.trim().toLowerCase();

export interface TaskOwners {
  readonly who: OwnerWho;
  readonly faceOf: (owner: string) => Face;
  /** What "Me" is followed by in the owner list; null when the page does not know who is looking. */
  readonly myName: string | null;
}

export function useTaskOwners(
  me: readonly string[],
  label: (value: string) => string,
  isAgent: (value: string) => boolean,
  agents: readonly string[],
): TaskOwners {
  const mine = useMemo(() => {
    const words = new Set<string>();
    for (const word of me) {
      if (word.trim() === "") continue;
      words.add(fold(word));
      words.add(fold(label(word)));
    }
    return words;
  }, [me, label]);
  const isPerson = useCallback((owner: string) => mine.has(fold(owner)) || mine.has(fold(label(owner))), [mine, label]);
  const isMe = useCallback(
    (owner: string) => {
      if (isPerson(owner)) return true;
      const whose = parseAgentOwner(owner, agents)?.whose ?? null;
      return whose !== null && isPerson(whose);
    },
    [isPerson, agents],
  );
  const who = useMemo<OwnerWho>(() => ({ isMe, isAgent, label }), [isMe, isAgent, label]);
  const faceOf = useCallback(
    (owner: string): Face => (isAgent(owner) ? { kind: "agent" } : { kind: "person", name: label(owner) }),
    [isAgent, label],
  );
  const first = me.find((word) => word.trim() !== "" && !word.includes("@")) ?? null;
  return { who, faceOf, myName: mine.size === 0 ? null : (first ?? label(me[0] ?? "")) };
}
