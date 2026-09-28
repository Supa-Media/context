/**
 * An agent's name, split into whose it is and what it is.
 *
 * The gateway names an agent by its owner and its client, "@jon's Claude"
 * (`presenceActor`), because several people's agents work in one shared
 * workspace and "Claude" alone does not say which (the owner, 2026-09-27).
 * The full name is long for a caret's flag or a 22px avatar, so those draw it
 * compactly: the owner's face, then the agent. A person's name ("@jon") never
 * has the possessive, so it is never split.
 */

export interface AgentName {
  /** "@jon", or `null` for an agent with no owner in its name. */
  owner: string | null;
  /** "Claude". */
  agent: string;
}

export function agentName(name: string): AgentName {
  const match = /^(@[A-Za-z0-9][A-Za-z0-9_.-]*)['’]s (.+)$/.exec(name);
  return match === null ? { owner: null, agent: name } : { owner: match[1]!, agent: match[2]! };
}
