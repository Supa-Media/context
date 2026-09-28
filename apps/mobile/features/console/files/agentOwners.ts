/**
 * An agent owner as text: `Claude`, or somebody's, `@shay's Claude`. Pure
 * and dependency-free, so the editor's list-block menu can share it; the
 * list itself, and where it is kept, is `folderPage/agents.ts`.
 */

const MAX_AGENT = 40;
const fold = (text: string) => text.trim().toLowerCase();

/** A name somebody typed, as it would go in the list, or why it cannot. */
export function agentName(typed: string): { name: string } | { problem: string } {
  const name = typed.replace(/\s+/g, " ").trim();
  if (name === "") return { problem: "An agent needs a name." };
  if (name.length > MAX_AGENT) return { problem: "That name is too long for an agent." };
  // The list is one comma-separated line, and an owner line is `@who's Agent`.
  if (/[,\n#:[\]]/.test(name) || name.startsWith("@") || /'s /i.test(name)) return { problem: "Agent names can’t use , # : [ ] or start with @." };
  return { name };
}

/** The agent in `list` spelled like `typed`, if any. */
export function knownAgent(list: readonly string[], typed: string): string | null {
  return list.find((agent) => fold(agent) === fold(typed)) ?? null;
}

/** What an owner line says for `agent`, whoever's it is (`whose` a person's owner value). */
export function agentOwner(agent: string, whose: string | null): string {
  return whose === null ? agent : `${whose}'s ${agent}`;
}

/**
 * Which agent an owner line names, and whose it is: `Claude` → Claude and
 * nobody's, `@shay's Claude` → Claude and `@shay`. Null for an owner that is
 * not an agent in `list`.
 */
export function parseAgentOwner(value: string, list: readonly string[]): { agent: string; whose: string | null } | null {
  const text = value.trim();
  for (const agent of list) {
    if (fold(text) === fold(agent)) return { agent, whose: null };
    const tail = `'s ${fold(agent)}`;
    if (fold(text).endsWith(tail) && text.length > tail.length) {
      const whose = text.slice(0, text.length - tail.length).trim();
      if (whose !== "") return { agent, whose };
    }
  }
  return null;
}
