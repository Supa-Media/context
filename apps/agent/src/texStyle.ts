/**
 * How Tex talks in a chat, as the control plane says it (Dev2, 2026-11-01;
 * `docs/decisions/texting-assistant/custom-instructions.md`).
 *
 * The people's own instructions are the one source of truth: a person's own
 * hold in their 1:1 chat, a group's in the group, and nobody's personal ones
 * ever reach a group. They change only by asking Tex in words, which the
 * gateway's `tex_instructions_set` tool saves (`apps/mcp/src/agent/commandTools.js`).
 * The "Tex, settings" menu, its quick picks and its progress-updates switch
 * are retired (Dev2, 2026-11-11; `docs/decisions/texting-assistant/retire-settings.md`);
 * a progress-updates level saved before then is still read and honoured.
 */

import { record } from "./clients";

export type Updates = "off" | "planOnly" | "normal";
/** What a chat's settings are, as the control plane says them. */
export type Settings = { instructions?: string; updates?: Updates };

const UPDATES: readonly Updates[] = ["off", "planOnly", "normal"];
const MAX_INSTRUCTIONS = 1_500;

/** Settings from the control plane, kept to what they may be; `{}` for none. */
export function readSettings(value: unknown): Settings {
  const body = record(value);
  const instructions = typeof body.instructions === "string" && body.instructions.length <= MAX_INSTRUCTIONS && body.instructions.trim() !== "" ? body.instructions : undefined;
  const updates = UPDATES.includes(body.updates as Updates) ? (body.updates as Updates) : undefined;
  return { ...(instructions ? { instructions } : {}), ...(updates ? { updates } : {}) };
}
