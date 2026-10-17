/**
 * The words of a key's People section (vault sharing boards 1 to 3): who it
 * can be given to, each row's line, how much they get, and what Take back
 * says. Kept apart from the panel so the rules are tested without drawing it.
 */

import { vaultDay, type VaultClient, type VaultEntry, type VaultLevel, type VaultShareRow } from "./vaultSettings";

/** What `vaultShareChoices` answers: who in this workspace a key can be given to. */
export type VaultShareChoices = {
  workspace: { handle: string; kind: "personal" | "shared" };
  people: { userId: string; name: string; handle: string | null; role: "owner" | "editor" | "member"; isMe: boolean }[];
  groups: { to: string; label: string; count: number }[];
  members: number;
};

/** A shared workspace a personal key can move to (`vaultMoveTargets`). */
export type VaultMoveTarget = { workspaceId: string; handle: string; name: string };

/** What moving a personal key says, once, before it happens. */
export function moveLine(handle: string): string {
  return `It leaves your personal workspace for @${handle}. Only you have it there until you give it to someone, and your AIs ask again the first time they use it.`;
}

export type GiveSuggestion = { to: string; kind: VaultShareRow["kind"]; title: string; sub: string };

export const LEVEL_OPTIONS: ReadonlyArray<{ value: VaultLevel; label: string }> = [
  { value: "use", label: "Their AIs use it" },
  { value: "see", label: "They can see it too" },
];

export function levelLabel(level: VaultLevel): string {
  return level === "see" ? "They can see it too" : "Their AIs use it";
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * What the Give field offers for what was typed: the whole workspace, its
 * groups, then its people, leaving out whoever already has the key by name.
 * Nothing outside the workspace is ever offered.
 */
export function giveSuggestions(choices: VaultShareChoices, typed: string, entry: VaultEntry, limit = 6): GiveSuggestion[] {
  const query = typed.trim().replace(/^@/, "").toLowerCase();
  const has = new Set((entry.people ?? []).map((row) => row.to));
  const matches = (...words: (string | null)[]) => query === "" || words.some((word) => word?.toLowerCase().includes(query));
  const out: GiveSuggestion[] = [];
  const handle = `@${choices.workspace.handle}`;
  if (!has.has("*") && matches("everyone", handle, choices.workspace.handle)) {
    out.push({ to: "*", kind: "everyone", title: `Everyone in ${handle}`, sub: `${people(choices.members)}, and anyone who joins later` });
  }
  for (const group of choices.groups) {
    if (has.has(group.to) || !matches(group.label, group.to)) continue;
    out.push({ to: group.to, kind: "group", title: group.label, sub: `Group · ${people(group.count)}` });
  }
  for (const person of choices.people) {
    if (person.isMe || has.has(person.userId) || !matches(person.name, person.handle)) continue;
    const role = person.role === "member" ? "member" : `${person.role} in ${handle}`;
    out.push({ to: person.userId, kind: "person", title: person.name, sub: person.handle ? `@${person.handle} · ${role}` : role });
  }
  return out.slice(0, limit);
}

/** The line under a person, group or the workspace in the People section; the saver is listed first. */
export function shareRowLine(row: VaultShareRow, saver: boolean, now: Date = new Date()): string {
  if (saver) return "Saved it · can change it";
  const given = `Given ${vaultDay(row.at, now)}`;
  if (row.kind === "everyone") return `${given} · ${people(row.count ?? 0)}, and anyone who joins later`;
  if (row.kind === "group") return `${given} · ${people(row.count ?? 0)}`;
  return given;
}

/** What Take back says, once, before it happens. */
export function takeBackLine(row: VaultShareRow): string {
  if (row.kind === "person") return `${row.name} and ${row.name}'s AIs lose the key now.`;
  return `${row.kind === "everyone" ? "Everyone here" : `Everyone in ${row.name}`} who has it no other way, and their AIs, lose it now.`;
}

/**
 * Each person's AIs, under their row: a person given the key by name gets
 * theirs nested, and anybody who has it through a group or the workspace
 * gets a row of their own after, so every AI on the key sits under somebody.
 */
export function aisByPerson(entry: VaultEntry): { rows: Map<string, VaultClient[]>; others: { by: string; name: string; clients: VaultClient[] }[] } {
  const named = new Set((entry.people ?? []).filter((row) => row.kind === "person").map((row) => row.to));
  const rows = new Map<string, VaultClient[]>();
  const others = new Map<string, { by: string; name: string; clients: VaultClient[] }>();
  for (const client of entry.proxy?.clients ?? []) {
    const by = client.by ?? entry.people?.[0]?.to ?? "";
    if (named.has(by)) rows.set(by, [...(rows.get(by) ?? []), client]);
    else {
      const other = others.get(by) ?? { by, name: client.byName ?? "Someone", clients: [] };
      other.clients.push(client);
      others.set(by, other);
    }
  }
  return { rows, others: [...others.values()] };
}

/** Initials for a face: "Sayo Adeyemi" is "SA", "everyone" is the workspace's first letter. */
export function initialsOf(name: string): string {
  const words = name.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
