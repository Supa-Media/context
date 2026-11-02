/**
 * The names a chat's grant holds in the access rows, and the rules that render them for it. Guest mode is retired
 * (`docs/decisions/texting-assistant/group-guests.md`): a chat with people who aren't all here reads its home
 * (`lib/textGroupHomeOnly.ts`), and nothing else of the workspace.
 *
 *  - **The chat's name** (`READS_AS_CHAT`): every reader renders the rows a chat holds through it, so the gateway
 *    judges them as folded for that chat. Mirrored in `apps/mcp/src/privacy/engine.js`.
 *  - **The rules the chat's store holds** (`chatRules`): each row the chat holds is read as `team` and every other row
 *    as `private`. The gateway's tools judge by a store's rules at `team` tier without names, so this is what makes
 *    them see exactly the chat's rows. A row held only to view is listed in `readOnly`: read, never changed.
 */

import type { Rules } from "./log";
import { PrivacyOverrides } from "../privacy";
import type { RenderedAccess } from "./rowAccess";

/**
 * The name a chat's grant holds, so the binding renders its rules for it (`chatRules`) and the gateway judges them as
 * folded. Shaped like a row token, and spelled with letters no row id has. Mirrored in `apps/mcp/src/privacy/engine.js`.
 */
export const READS_AS_CHAT = "@#reads-as-chat";

/** As a granted name is stored and sent: without its `@`. */
export const READS_AS_CHAT_NAME = READS_AS_CHAT.slice(1);

/** Whether these names (with or without `@`) are a chat's. */
export function readsAsChat(names: Iterable<string> | undefined): boolean {
  for (const name of names ?? []) if (name === READS_AS_CHAT || name === READS_AS_CHAT_NAME) return true;
  return false;
}

/**
 * The rules the chat's store holds: a row token it holds is `team`, anything else `private`, and the rows it holds only
 * to view are named in `readOnly`. `names` are the chat's, with or without `@`.
 */
export function chatRules(guest: Rules, names: Iterable<string>): RenderedAccess & { readOnly: { folders: string[]; notes: string[] } } {
  const held = new Set([...names].map((name) => (name.startsWith("@") ? name : `@${name}`)));
  const readOnly = { folders: [] as string[], notes: [] as string[] };
  const read = (vis: string, path: string, list: string[]): "team" | "private" => {
    if (!vis.startsWith("@#") || !held.has(vis)) return "private";
    // A token is `@#<id>` and its edit name `@#<id>!edit` (`editNameFor`).
    if (!held.has(`${vis}!edit`)) list.push(path);
    return "team";
  };
  const rules = guest.rules.map((rule) => ({ prefix: rule.prefix, vis: read(rule.vis, rule.prefix, readOnly.folders) }));
  const overrides = new PrivacyOverrides();
  for (const [path, vis] of guest.overrides) overrides.set(path, read(vis, path, readOnly.notes));
  return { rules, overrides, readOnly };
}
