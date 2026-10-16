/**
 * The words on Settings › Vault (vault board 2), kept apart from the panel so
 * the rules are tested without drawing it. Every line here comes from a
 * key's names, websites and yeses: the page never holds a value.
 */

import { styleWords, type ProxyStyle } from "./vaultProxy";

export type VaultClient = { id: string; name: string | null; at: number };
export type VaultEntry = {
  entryId: string;
  type: "login" | "secret";
  name: string;
  sites: string[];
  envs: string[];
  shared: boolean;
  proxy: { host: string; style: ProxyStyle; name: string | null; ask: boolean; clients: VaultClient[] } | null;
};

/** The second line of a key's row: where it goes, or why no AI uses it. */
export function vaultRowLine(entry: VaultEntry): string {
  if (entry.proxy !== null) {
    const envs = entry.envs.length > 0 ? ` · ${entry.envs.join(", ")}` : "";
    return `Only to ${entry.proxy.host}${envs}`;
  }
  if (entry.type === "login") return entry.sites[0] ? `Login · Tex fills it on ${entry.sites[0]}` : "Login";
  return "Not given to AIs · you copy it yourself";
}

/** The detail's first sentence for a key AIs may use. */
export function vaultPinLine(proxy: NonNullable<VaultEntry["proxy"]>): string {
  const how = styleWords(proxy.style, proxy.name ?? "");
  return `Only ever sent to ${proxy.host} as ${proxy.style === "bearer" ? `a ${how}` : how}.`;
}

/** An AI's line under "AIs that can use it". */
export function vaultClientLine(client: VaultClient, now: Date = new Date()): string {
  const when = new Date(client.at);
  const sameYear = when.getFullYear() === now.getFullYear();
  const date = when.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return `${client.name ?? "An AI"} · You said yes ${date}`;
}

/** What the AIs list says when nobody is on it. */
export function vaultNoClientsLine(proxy: NonNullable<VaultEntry["proxy"]>): string {
  return proxy.ask
    ? "No AI yet. The first time one asks, you'll be asked here."
    : "Every AI you connected can use it without asking.";
}
