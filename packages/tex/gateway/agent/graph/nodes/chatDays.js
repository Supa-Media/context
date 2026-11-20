/**
 * Chat day summaries node "chatDays" (on the shelf, `texNodeShelf.json`; Dev2, 2026-11-16: "summaries should be running
 * every day", for every chat, groups included). On a `background` wire after Text them, so nobody waits for it: each
 * finished day of this turn's chat in the last three weeks with no summary yet, newest first and at most three a run,
 * is summed up into the chat's ledger (`daySummaries.js` `writeChatDaySummaries`), where the week's history reads it
 * before the last 7 days (`weekHistory.js`). A day is summed up the first text after it ends, days before it ages out
 * of the seven, so an older day always has its summary. A one-to-one chat's nightly run (`daysum`) goes on as before;
 * the two write one summary a day between them, by its id.
 */
import { aiGatewayConfig } from "../../aiGateway.js";
import { writeChatDaySummaries } from "../../daySummaries.js";
import { ledgerPlace } from "../../ledger.js";

/** How far back a run looks for a day with no summary, and how many it sums up. */
export const LOOKBACK_DAYS = 21;
export const MAX_DAYS_A_RUN = 3;

export default async function chatDays(_input, io) {
  const t = io.ctx.turn ?? {};
  if (t.env?.DAY_SUMMARIES === "off") return { outcome: "off" };
  const place = ledgerPlace(t.session);
  if (place === null || typeof t.store?.texLedger !== "function") return { outcome: "none" };
  const written = await writeChatDaySummaries({
    ledger: t.store.texLedger(place.owner.chat ?? null),
    chat: place.chat,
    group: t.group != null,
    now: Date.now(),
    timeZone: typeof t.timeZone === "string" ? t.timeZone : "UTC",
    config: aiGatewayConfig(t.env),
    metadata: { feature: "day-summary", workspace: String(t.session?.workspaceId ?? ""), client: "chatDays" },
    max: MAX_DAYS_A_RUN,
    lookbackDays: LOOKBACK_DAYS,
  });
  if (written === null) return { outcome: "none" };
  return { outcome: "done", written: written.written, missing: written.missing };
}
