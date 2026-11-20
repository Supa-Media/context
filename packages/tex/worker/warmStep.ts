/**
 * Warm the model's cache when the person reads Tex's text (node `warm`, on the gateway's shelf until a Lab draft wires
 * it; Dev2, 2026-11-20, the cache rules: "the cache is warmed when the chat opens or the person starts typing").
 * Photon's line hears the read (`photonSendStatus.ts`), and a person who just read Tex's text is the one most likely to
 * text next. The chat object asks the gateway's `/texts/warm` on the `TexTexts` binding, naming the chat's home: the
 * person's personal workspace for a 1:1, the group's ledger key for a group. The gateway decides whether to warm (a
 * kept prefix, from today, not sent in the last 50 minutes: `apps/mcp/src/agent/graph/nodes/warm.js`) and logs the
 * node's run in the chat's ledger; this step asks at most once every `ASK_AGAIN_MS` per chat, and never waits the chat.
 */

import type { TextsBinding } from "./gatewaySession";
import { TEXTS_WORKSPACE_KEY } from "./gatewaySession";
import { sha256Hex } from "./groupChat";
import type { InboxStorage } from "./inbox";
import type { SendStatus } from "./sendblueStatus";

/** A chat's read receipts come in bursts (each of Tex's bubbles): one ask per chat in this long. */
export const ASK_AGAIN_MS = 10 * 60 * 1000;
const ASKED_KEY = "warm:asked:";
const E164 = /^\+[1-9]\d{6,14}$/;

export type WarmOutcome = "asked" | "not_read" | "recent" | "no_home" | "no_gateway" | "failed";

/** The read of one of Tex's texts, told to the gateway's warm node when it is time to. Logged on every path; never throws. */
export async function warmOnRead(storage: InboxStorage, status: SendStatus, deps: { texts?: TextsBinding; now: () => number }): Promise<WarmOutcome> {
  const kind = status.object.kind === "group" ? "group" : "one";
  const done = (outcome: WarmOutcome): WarmOutcome => {
    console.log(JSON.stringify({ event: "warm_ask", cause: "read", kind, outcome }));
    return outcome;
  };
  try {
    if (status.report?.status !== "read") return "not_read";
    if (deps.texts === undefined) return done("no_gateway");
    const asked = await storage.get<number>(ASKED_KEY + status.chat);
    if (typeof asked === "number" && deps.now() - asked < ASK_AGAIN_MS) return done("recent");
    let home: { person: string } | { chat: string } | null = null;
    if (status.object.kind === "person") {
      const person = await storage.get<string>(TEXTS_WORKSPACE_KEY);
      home = typeof person === "string" && person !== "" ? { person } : null;
    } else if (typeof status.line === "string" && E164.test(status.line)) {
      home = { chat: await sha256Hex(`${status.line}:${status.object.groupId}`) };
    }
    if (home === null) return done("no_home");
    await storage.put(ASKED_KEY + status.chat, deps.now());
    const response = await deps.texts.fetch("https://gateway/texts/warm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...home, cause: "read" }) });
    return done(response.ok ? "asked" : "failed");
  } catch {
    return done("failed");
  }
}
