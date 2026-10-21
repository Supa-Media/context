/**
 * The words on Settings › Vault (vault board 2), kept apart from the panel so
 * the rules are tested without drawing it. Every line here comes from a
 * key's names, websites, yeses and uses: the page never holds a value.
 */

import { styleWords, type ProxyStyle } from "./vaultProxy";
import { cardLabel, type CardSummary } from "./vaultCard";

/** Whose AI a record is (`by`), their name ("You" for the reader), and whether it is the reader's. */
type Whose = { by?: string; byName?: string; mine?: boolean };
export type VaultClient = { id: string; name: string | null; at: number } & Whose;
export type VaultUse = { id: string; name: string | null; count: number; at: number; method: string; path: string } & Whose;
export type VaultLevel = "use" | "see";
/** One person, group or the whole workspace a key is given to; the saver first. */
export type VaultShareRow = {
  to: string;
  kind: "person" | "group" | "everyone";
  name: string;
  handle: string | null;
  /** How many people a group or the workspace reaches; null for a person. */
  count: number | null;
  level: VaultLevel;
  at: number;
  isYou: boolean;
};
export type VaultEntry = {
  entryId: string;
  type: "login" | "secret" | "card";
  name: string;
  sites: string[];
  envs: string[];
  /** A card's brand, last four and expiry; never its number. */
  card?: CardSummary;
  shared: boolean;
  proxy: {
    host: string;
    style: ProxyStyle;
    name: string | null;
    /** A named header's word before the key ("Convex"), or null. */
    prefix?: string | null;
    ask: boolean;
    clients: VaultClient[];
    /** Each AI's count and last call (`apps/mcp/src/vault/usage.js`). */
    uses: VaultUse[];
    /** The AIs the person said no to. */
    refused: VaultClient[];
    /** How many AIs wait on a first-use ask now. */
    waiting: number;
  } | null;
  savedAt: number;
  savedByYou: boolean;
  /** Who saved it ("You" for the reader). */
  savedBy?: string;
  /** What the reader may do: use it (through their AI tools), or use and see it. */
  level?: VaultLevel;
  /** Whether the reader may give it, take it back, and cut anybody's AI off. */
  manage?: boolean;
  /** Who gave it to the reader, or null for the saver. */
  givenBy?: string | null;
  /** Given to the reader by name, so they can hand it back. */
  givenToYou?: boolean;
  /** Who has it; only for somebody who may manage it. */
  people?: VaultShareRow[];
};

/** Whether the reader may give the key and see everybody's AIs; older lists: whoever saved it. */
export function mayManage(entry: VaultEntry): boolean {
  return entry.manage ?? entry.savedByYou;
}

export type VaultFilter = "all" | "ai" | "given" | "logins" | "stale";
export const VAULT_FILTERS: { key: VaultFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ai", label: "Used by AIs" },
  { key: "given", label: "Shared with others" },
  { key: "logins", label: "Logins" },
  { key: "stale", label: "Not used in 90 days" },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A day as the board writes it: "16 Oct", with the year when it is not this one. */
export function vaultDay(at: number, now: Date = new Date()): string {
  const when = new Date(at);
  const sameYear = when.getFullYear() === now.getFullYear();
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** How long ago, short ("4 min ago") for a pill or long ("4 minutes ago") for a sentence. */
export function vaultAgo(at: number, now: Date = new Date(), long = false): string {
  const gap = Math.max(0, now.getTime() - at);
  if (gap < MINUTE) return "just now";
  if (gap < HOUR) {
    const minutes = Math.floor(gap / MINUTE);
    return long ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago` : `${minutes} min ago`;
  }
  if (gap < DAY) {
    const hours = Math.floor(gap / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(gap / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${vaultDay(at, now)}`;
}

/** "6 keys · 1 login · 1 card": secrets are keys, logins and cards are counted apart. */
export function vaultCountLine(entries: VaultEntry[]): string {
  const logins = entries.filter((entry) => entry.type === "login").length;
  const cards = entries.filter((entry) => entry.type === "card").length;
  const keys = entries.length - logins - cards;
  const parts = [
    keys > 0 || logins + cards === 0 ? `${keys} ${keys === 1 ? "key" : "keys"}` : null,
    logins > 0 ? `${logins} ${logins === 1 ? "login" : "logins"}` : null,
    cards > 0 ? `${cards} ${cards === 1 ? "card" : "cards"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The latest use of a key by any AI, or null. */
export function lastUse(entry: VaultEntry): VaultUse | null {
  const uses = entry.proxy?.uses ?? [];
  return uses.reduce<VaultUse | null>((latest, use) => (latest === null || use.at > latest.at ? use : latest), null);
}

/** Whether a key is shown under a filter chip. */
export function inFilter(entry: VaultEntry, filter: VaultFilter, now: Date = new Date()): boolean {
  if (filter === "ai") return entry.proxy !== null;
  if (filter === "given") return entry.shared;
  if (filter === "logins") return entry.type === "login";
  if (filter === "stale") {
    const last = lastUse(entry)?.at ?? entry.savedAt;
    return now.getTime() - last > 90 * DAY;
  }
  return true;
}

/** The second line of a key's row: where it goes, or why no AI uses it. */
export function vaultRowLine(entry: VaultEntry): string {
  if (entry.proxy !== null) {
    const envs = entry.envs.length > 0 ? ` · ${entry.envs.join(", ")}` : "";
    return `Only to ${entry.proxy.host}${envs}`;
  }
  if (entry.type === "login") return entry.sites[0] ? `Login · Tex fills it on ${entry.sites[0]}` : "Login";
  if (entry.type === "card") return `${cardLabel(entry.card)} · ${entry.sites[0] ? `pays on ${entry.sites[0]}` : "any checkout"}, asks you each time`;
  return "Not given to AIs · you copy it yourself";
}

/** The pill at a row's end, or null for a key no AI uses. */
export function vaultRowPill(entry: VaultEntry, now: Date = new Date()): { text: string; tone: "ok" | "warn" | "neutral" } | null {
  const proxy = entry.proxy;
  if (proxy === null) return null;
  if (proxy.waiting > 0) return { text: `${proxy.waiting} ${proxy.waiting === 1 ? "AI" : "AIs"} waiting for you`, tone: "warn" };
  const last = lastUse(entry);
  if (last !== null) return { text: `used ${vaultAgo(last.at, now)}`, tone: now.getTime() - last.at < HOUR ? "ok" : "neutral" };
  return { text: proxy.clients.length === 0 ? "no AI yet" : "not used yet", tone: "neutral" };
}

/** The detail's line under the name. */
export function vaultSavedLine(entry: VaultEntry, now: Date = new Date()): string {
  if (entry.savedByYou || entry.savedBy === undefined) return `Saved ${entry.savedByYou ? "by you " : ""}on ${vaultDay(entry.savedAt, now)}`;
  if (entry.givenBy) return `Shared with you by ${entry.givenBy}${entry.level === "use" ? " · use only" : ""}`;
  return `Saved by ${entry.savedBy} on ${vaultDay(entry.savedAt, now)}`;
}

/** An AI's name as somebody else reads it: "Sayo's Claude Code". */
export function whoseAI(record: { name: string | null } & Whose): string {
  const name = record.name ?? "An AI";
  return record.mine === false && record.byName ? `${record.byName}'s ${name}` : name;
}

/** The detail's first sentence for a key AIs may use: how it is sent. */
export function vaultPinLine(proxy: NonNullable<VaultEntry["proxy"]>): string {
  const how = styleWords(proxy.style, proxy.name ?? "", proxy.prefix ?? "");
  return `as ${proxy.style === "bearer" ? `a ${how}` : how}`;
}

/** An AI's line under "AIs that can use it": the day of the yes and how often it used the key. */
export function vaultClientLine(client: VaultClient, uses: VaultUse[] = [], now: Date = new Date()): string {
  const count = uses.find((use) => use.id === client.id && use.by === client.by)?.count ?? 0;
  const used = count === 0 ? "" : count === 1 ? " · used once" : ` · used ${count} times`;
  return `${client.mine === false && client.byName ? client.byName : "You"} said yes ${vaultDay(client.at, now)}${used}`;
}

/** An AI the person said no to. */
export function vaultRefusedLine(refusal: VaultClient, now: Date = new Date()): string {
  return `${refusal.mine === false && refusal.byName ? refusal.byName : "You"} said no ${vaultDay(refusal.at, now)}`;
}

/** What the AIs list says when nobody is on it. */
export function vaultNoClientsLine(proxy: NonNullable<VaultEntry["proxy"]>): string {
  return proxy.ask
    ? "No AI yet. The first time one asks, you'll be asked here."
    : "Every AI you connected can use it without asking.";
}

/**
 * What an address was about, from its path: the last part that is a word
 * rather than a version or an id ("/v1/customers/cus_123" is "customers").
 */
function subjectOf(path: string): string | null {
  const parts = path
    .split("/")
    .map((part) => decodeURIComponentSafe(part).trim())
    .filter((part) => part.length > 0 && part.length <= 40)
    .filter((part) => !/^v\d+(\.\d+)?$/i.test(part) && !/^(api|rest)$/i.test(part))
    .filter((part) => !/\d/.test(part) && /^[a-z][a-z_-]*$/i.test(part));
  const last = parts.at(-1);
  return last ? last.replace(/[_-]+/g, " ").toLowerCase() : null;
}

function decodeURIComponentSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** "Claude Code read your customers, 4 minutes ago." The key's last use, in a sentence. */
export function vaultLastUsedLine(entry: VaultEntry, now: Date = new Date()): string | null {
  const last = lastUse(entry);
  if (last === null || entry.proxy === null) return null;
  const who = whoseAI(last);
  const subject = subjectOf(last.path);
  const verb = last.method === "GET" || last.method === "HEAD" ? "read" : last.method === "DELETE" ? "deleted from" : "wrote to";
  const what = subject === null ? entry.proxy.host : `your ${subject}`;
  return `${who} ${verb} ${what}, ${vaultAgo(last.at, now, true)}.`;
}
