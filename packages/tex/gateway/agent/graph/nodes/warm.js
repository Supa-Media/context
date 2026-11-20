/**
 * Node `warm` (shelf; Dev2, 2026-11-20, the cache rules: "the cache is warmed when the chat opens or the person starts
 * typing"; `../../warmPrefix.js`). Asked over `/texts/warm` (`../../textsWarm.js`) when the person reads Tex's text, opens
 * the chat or starts typing. It reads the chat's kept prefix from its home (`texStore/warm.js`) and sends it again with a
 * one-token answer, so the model's cache holds it when their text arrives.
 *
 * Skipped, and said why, when nothing is kept, when the prefix is from another day (the next turn's frozen modules and
 * history window are not the same bytes, `frozenModules.js`), or when it was sent less than `WARM_AGAIN_MS` ago (the
 * cache still holds it for an hour; a read receipt right after Tex's reply costs nothing then).
 *
 * Input `{ owner: {person}|{chat}, chat, cause: "read"|"open"|"typing" }`. Output `{ when: ["warmed"], usage, ms }` or
 * `{ when: ["skip"], why, ms }`. Never throws; a failure is `skip` with the error's name.
 */
import { aiGatewayConfig, requestViaGateway } from "../../aiGateway.js";
import { dayOf } from "../../jobLog.js";
import { ledgerFor } from "../../ledger.js";
import { warmRequest } from "../../warmPrefix.js";

/** The model keeps a prefix an hour after its last use: warming sooner than this only reads what is already there. */
export const WARM_AGAIN_MS = 50 * 60 * 1000;

export async function warmNode(input, io) {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const env = io?.ctx?.env ?? io?.env ?? null;
  const now = typeof io?.ctx?.now === "function" ? io.ctx.now : Date.now;
  const skip = (why) => ({ when: ["skip"], why, ms: ms() });
  try {
    const home = (io?.ctx?.ledgerOf ?? ((owner) => ledgerFor(env, owner)))(input?.owner);
    if (home === null || typeof home.warmOf !== "function") return skip("no home");
    const kept = await home.warmOf(input.chat);
    if (kept === null || typeof kept?.body?.model !== "string") return skip("nothing kept");
    if (kept.day !== dayOf(now(), kept.zone || "UTC")) return skip("another day");
    if (now() - kept.used < WARM_AGAIN_MS) return skip("still warm");
    const request = io?.ctx?.request ?? requestViaGateway;
    const answer = await request({ model: `anthropic/${kept.body.model}` }, aiGatewayConfig(env), {
      rawBody: warmRequest(kept.body),
      metadata: { feature: "assistant", workspace: String(input.owner?.person ?? input.owner?.chat ?? ""), client: "warm" },
    });
    await home.warmUsed(input.chat);
    const usage = answer?.usage ?? {};
    return { when: ["warmed"], usage: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }, ms: ms() };
  } catch (error) {
    // The failure's name only: a provider's error can quote the request, which is the person's chat.
    return skip(`error:${typeof error?.name === "string" ? error.name : "error"}`);
  }
}
