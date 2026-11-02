/**
 * Tex's own read of its setup in the pinned workspace (`ai/production/`, and the helper agents' `ai/agents/`).
 *
 * Every Tex turn runs on `ai/production/texting-assistant.md`, its skills and its jobs' setups (heartbeat,
 * housekeeping, dreams). Those notes are staff-only `team` rows in the pin. Until 2026-11-02 the gateway read them
 * through the person's own reach there, so a person who is not a member of the pin (a pin reader, read as a guest),
 * and every group chat once its setup row was read as the chat (#2498, 2026-10-31), read nothing, and Tex silently
 * ran on its built-in words: no open web, five pages a turn, none of the setup's rules (owner, 2026-11-02: "peoples
 * tex should always have access to the production note").
 *
 * So a Tex client's token may ask for the pin's binding with `setupRead`, and gets it with rules rendered for a
 * member and then narrowed (`setupRules`) to these folders alone: everything else in the pin is `private`, which a
 * read at `team` never sees. The person's own reach in the pin is unchanged, and nothing here is listed or
 * addressable by a tool; the gateway uses it only to read the setup (`apps/mcp/src/agent/production.js`).
 */

import { visibilityOf, type PrivacyRule, type Visibility } from "./privacy";
import type { Rules } from "./nodes/log";

/** The clients that are Tex: its texted turns, group chats, routines and its own jobs. Never an AI client or the console. */
export const TEX_SETUP_CLIENTS: ReadonlySet<string> = new Set([
  "context_texts",
  "context_texts_group",
  "context_routines",
  "context_heartbeat",
  "context_housekeeping",
  "context_dreams",
]);

/** The only folders the setup read opens, with no trailing slash. */
export const SETUP_FOLDERS: readonly string[] = ["ai/production", "ai/agents"];

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * A member's rules, narrowed to `SETUP_FOLDERS`: each folder keeps the visibility a member reads it at (its nearest
 * rule, written out so a dropped parent cannot change it), with every rule and note exception beneath it, and nothing
 * else. A path outside them matches no rule and is `private`.
 */
export function setupRules(member: Rules): { rules: PrivacyRule[]; overrides: Map<string, Visibility> } {
  const rules: PrivacyRule[] = [];
  for (const folder of SETUP_FOLDERS) {
    rules.push({ prefix: folder, vis: visibilityOf(folder, member.rules) });
    for (const rule of member.rules) if (rule.prefix !== folder && under(rule.prefix, folder)) rules.push({ prefix: rule.prefix, vis: rule.vis });
  }
  const overrides = new Map<string, Visibility>();
  for (const [path, vis] of member.overrides) if (SETUP_FOLDERS.some((folder) => under(path, folder))) overrides.set(path, vis);
  return { rules, overrides };
}
