/**
 * When Tex speaks up in a group without being named. It is the one judge's to
 * read, never a gate in code (Dev2, 2026-11-11): every message reaches the
 * judge, which is told the level (`textDecide.cjs` `STYLE_RULES`).
 *
 * Since 2026-11-11 (Dev2; `docs/decisions/texting-assistant/retire-settings.md`)
 * there is one level for every group, follow-along: Tex answers what is for it
 * (its name, a tag, a reply to it, an answer to its question) and a follow-up
 * to what it just said. Nobody is asked to pick a style and there is no menu;
 * the levels a chat chose before are no longer read. "Tex, stop" still mutes
 * a chat, kept apart from this (`groupControl.ts`).
 *
 * Since 2026-11-17 the judge is told no level in a group at all (Dev2: "I just
 * want decide to know when to answer or not"); this value only fills the body's
 * `style` field, which the judge reads for a 1:1 chat alone (`textDecide.cjs`).
 */

import type { GroupStyle } from "./decide";

/** The style the judge is told: follow-along, in every group. */
export async function groupStyle(): Promise<{ style: GroupStyle }> {
  return { style: "followAlong" };
}
