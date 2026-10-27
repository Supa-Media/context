/**
 * The standing forward's gate (`forwardRule.js`): a rule that lets a routine
 * send without asking is kept only on the person's 👍 to that rule, held the
 * way `calendarGate.js` holds a calendar change. Tex may ask by text, another
 * AI's ask is answered in the app, and a routine or a dream never may. A stop
 * only narrows, so it goes straight through.
 */

import { callKey, createPending, findPending, ALREADY_ASKED, shownBefore, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { FORWARD_RULE_TOOL, forwardRuleCopy, forwardRuleSummary, readForwardRule, readRules } from "./forwardRule.js";
import { emailCaller } from "./emailGate.js";

export { FORWARD_RULE_TOOL };

/** `null` to let a stop or an approved start through, or the answer to give instead. */
export async function forwardRuleGate(supplied, { store, session, target }) {
  if (session.egress?.approved === true) return null;
  if (target.workspaceId !== session.workspaceId) {
    return toolError("Not changed: forward_rule takes no context. It always forwards the person's own mail.");
  }
  const read = readForwardRule(supplied);
  if (read.error) return toolError(`Not changed: ${read.error}`);
  if (read.stop) return null;

  const userId = session.actorUserId;
  const released = await takeDone(store, { name: FORWARD_RULE_TOOL, args: supplied, userId, clientId: session.actorClientId });
  if (released) return released;
  if (emailCaller(session.actorClientId) === null) {
    return toolError("Not changed: only the person, through Tex or the app, can let a routine forward their mail.");
  }
  const kept = await readRules(store);
  if (kept.some((rule) => rule.routine === read.rule.routine && rule.to === read.rule.to && rule.about === read.rule.about)) {
    return toolError(`Not changed: ${read.rule.routine} already forwards ${read.rule.about} to ${read.rule.to}.`);
  }

  const texting = session.egress?.texting === true;
  const ledger = session.egress?.ledger ?? null;
  if (texting && ledger?.asked.some((asked) => asked.tool === FORWARD_RULE_TOOL && asked.key !== callKey(FORWARD_RULE_TOOL, supplied))) {
    return toolError("Not changed: one standing forward at a time by text. Ask about this one after the person answers.");
  }
  const existing = await findPending(store, { name: FORWARD_RULE_TOOL, args: supplied, userId });
  if (session.egress?.texting === true && shownBefore(existing)) return toolError(ALREADY_ASKED);
  const record =
    existing?.record ??
    (await createPending(store, {
      name: FORWARD_RULE_TOOL,
      args: supplied,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: forwardRuleSummary(read.rule), audience: "outside" },
      detail: forwardRuleCopy(read.rule),
      workspaceId: target.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError("Not changed: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      texting
        ? "Held for their 👍, and nothing failed: right after your answer, in this same reply, they are shown this rule and asked once. " +
            "Say in one short line what you'd keep doing, without repeating it or asking for their 👍. Don't call this again in this turn."
        : "Not changed yet: the person must approve this rule in the Context app. " +
            "Once they have, call forward_rule again with exactly the same arguments and you will be told it was kept.",
    ),
    held: true,
  };
}
