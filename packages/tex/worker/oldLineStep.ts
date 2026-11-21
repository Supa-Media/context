/**
 * The old-number step for one arriving 1:1 text (node `oldLine`, `texConfig.json`, between "A text arrives" and Triage).
 * The chat object asks the gateway's graph (`/texts/old-line` on `TexTexts`), handing it the staff setting it read
 * (`oldLine.ts`, cached a minute) and when this chat was last told; on `redirect` it sends the one reply on the chat's
 * own line, notes the time, and the text takes no turn; a later text that day is held, with no reply and no turn. On anything else, a failure included, the text goes on to
 * Triage: a text is never dropped because this step could not answer. Logs carry the outcome, never a number or words.
 */

import type { TextsBinding } from "./gatewaySession";
import type { InboxStorage } from "./inbox";
import { lineFor, lineSeam, type Line, type LineDeps } from "./line";
import { readOldLine, type OldLineDeps } from "./oldLine";
import { logStep } from "./stepEvents";

/** When this chat was last sent the old-number reply (ms), kept in the chat's own object. */
export const OLD_LINE_TOLD_KEY = "oldLine:toldAt";

export type OldLineStepDeps = OldLineDeps & LineDeps & { texts?: TextsBinding; remoteLine?: (chatId: string) => Line };

type Outcome = "redirected" | "held" | "pass";

/**
 * The chats on Tex's old number: only a text there can be redirected or held (the node's own `SENDBLUE_CHAT`, in
 * `graph/nodes/oldLine.js`). Every other text (Photon's line, WhatsApp) passes without the setting's read or the
 * gateway's call, which cost each iMessage text up to 0.9 s before it reached the queue (2026-11-21, Dev2: "There's a
 * gap between an app and iMessage").
 */
export const OLD_LINE_CHAT = /^sendblue:/;

/** What the step's ledger record carries: whether each setting is there, never the number, the chat or words. */
type Seen = { mode?: string; number?: boolean; archiveOn?: boolean; toldAgoMs?: number };

/** "redirected" when the reply went, "held" when this chat was told today; either way the text takes no turn. "pass": on to Triage. */
export async function oldLineStep(storage: InboxStorage, chatId: string, deps: OldLineStepDeps): Promise<Outcome> {
  const started = Date.now();
  const seen: Seen = {};
  const done = async (outcome: Outcome, cause?: string, answerChars?: number, why?: string): Promise<Outcome> => {
    console.log(JSON.stringify({ event: "old_line", outcome, ...(cause ? { reason: cause } : why ? { reason: why } : {}) }));
    const to = outcome === "redirected" ? "redirect" : outcome === "held" ? "hold" : "pass";
    await logStep(storage, chatId, {
      name: "oldLine",
      ok: cause === undefined,
      ms: Date.now() - started,
      input: seen,
      output: { to, ...(answerChars !== undefined ? { answerChars } : {}), ...(why ? { why } : {}) },
      ...(cause ? { cause } : {}),
    }, deps.now());
    return outcome;
  };
  if (!OLD_LINE_CHAT.test(chatId)) return await done("pass", undefined, undefined, "new_line");
  if (deps.texts === undefined) return await done("pass", "no_gateway");
  let setting;
  try {
    setting = await readOldLine(deps);
  } catch {
    return await done("pass", "setting_unread");
  }
  const now = deps.now();
  const lastToldAt = await storage.get<number>(OLD_LINE_TOLD_KEY);
  Object.assign(seen, { mode: setting.mode, number: setting.number !== null, archiveOn: setting.archiveOn !== null, ...(typeof lastToldAt === "number" ? { toldAgoMs: now - lastToldAt } : {}) });
  const input = {
    chatId,
    mode: setting.mode,
    ...(setting.number !== null ? { number: setting.number } : {}),
    ...(setting.archiveOn !== null ? { archiveOn: setting.archiveOn } : {}),
    ...(typeof lastToldAt === "number" ? { lastToldAt } : {}),
    now,
  };
  let output: { to?: unknown; answer?: unknown };
  try {
    const response = await deps.texts.fetch("https://gateway/texts/old-line", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) return await done("pass", `gateway_${response.status}`);
    output = (await response.json()) as typeof output;
  } catch {
    return await done("pass", "gateway_unreachable");
  }
  if (output.to === "hold") return await done("held");
  if (output.to !== "redirect" || typeof output.answer !== "string" || output.answer === "") return await done("pass");
  // Noted before the send, so a retried webhook does not text the reply twice.
  await storage.put(OLD_LINE_TOLD_KEY, now);
  try {
    const line = lineFor(lineSeam(deps), chatId);
    await line.sendText(chatId, output.answer, `old-line:${chatId}:${Math.floor(now / 86_400_000)}`);
  } catch {
    // Not told after all: the text goes on to Tex, who still answers on this line.
    await storage.delete(OLD_LINE_TOLD_KEY);
    return await done("pass", "send_failed", output.answer.length);
  }
  return await done("redirected", undefined, output.answer.length);
}
