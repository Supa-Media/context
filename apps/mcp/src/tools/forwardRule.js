/**
 * A STANDING FORWARD: ONE 👍 LETS A ROUTINE KEEP FORWARDING ONE KIND OF MAIL TO
 * ONE ADDRESS (Dev2, 2026-10-21: "for the receipts and stuff like that I
 * expected it to consistently handle all of my receipts, no need for asking
 * for approval each time ... the user is essentially approving forwarding
 * mail to the relay address").
 *
 * Every other email waits for a yes to its exact copy (`emailGate.js`), and a
 * routine never sends at all. A standing forward is the one exception, and it
 * is narrow on purpose:
 *
 *   1. It is asked for like an email: Tex calls `forward_rule` with the
 *      routine that will do the forwarding, the one address mail goes to and
 *      a few words on what is forwarded. The person is shown that rule and
 *      their 👍 keeps it (`forwardRuleGate`).
 *   2. The rule is kept in the bucket's plumbing (`RULES_KEY`), where no
 *      note write reaches, never in the routine's note: editing the note
 *      cannot change where mail goes.
 *   3. Only that routine's own run may use it, and only to forward one of the
 *      person's emails, by its id, to that address alone, once per email
 *      (`standingForward`). The limits still apply. Anything else a routine
 *      sends is refused as before.
 *   4. "Stop forwarding receipts" removes it at once, with no yes: stopping
 *      only narrows.
 */

import { routineFromPath } from "../../../../packages/shared/src/routines.cjs";
import { getWithLegacyFallback } from "../storageLayout.js";
import { toolError, toolText } from "./results.js";
import { readEmail, toolSendEmail } from "./email.js";
import { parseEmailId } from "./emailRead.js";

export const FORWARD_RULE_TOOL = "forward_rule";
export const RULES_KEY = ".context/standing/forward-rules.json";
export const MAX_RULES = 10;
export const MAX_ABOUT = 120;
/** The emails a rule remembers having forwarded, newest kept. */
export const MAX_REMEMBERED = 500;

const ROUTINES_CLIENT_ID = "context_routines";
const CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** `{ rule }` for a start, `{ stop }` for a stop, or `{ error }` saying what to fix. */
export function readForwardRule(args) {
  const action = args?.action ?? "start";
  if (action !== "start" && action !== "stop") return { error: 'action is "start" or "stop".' };
  const routine = typeof args?.routine === "string" ? args.routine.trim().replace(/^\/+/, "") : "";
  if (action === "stop") return routine === "" ? { error: "Name the routine whose forwarding stops." } : { stop: routine };
  const found = routineFromPath(routine);
  if (found?.kind !== "routine" || !routine.startsWith("tex/routines/")) {
    return { error: "routine is the path of a routine note under tex/routines/<schedule>/, like tex/routines/hourly/forward-receipts.md. Write the note first." };
  }
  const read = readEmail({ to: args?.to, subject: "x", body: "x" });
  if (read.error || read.email.to.length !== 1) return { error: "to is the one email address mail is forwarded to." };
  const about = typeof args?.about === "string" ? args.about.trim() : "";
  if (about === "" || about.length > MAX_ABOUT || CONTROL.test(about)) {
    return { error: `about is a few words on what is forwarded, like "receipts and invoices", at most ${MAX_ABOUT} characters.` };
  }
  return { rule: { routine, to: read.email.to[0], about } };
}

/** The rule as the person reads it before their 👍. */
export function forwardRuleCopy(rule) {
  return [
    `From now on, forward ${rule.about} from your mail to ${rule.to}, attachments and all, without asking each time.`,
    "",
    `The routine that does it: ${rule.routine}`,
    "It can only forward your own emails, only to that address, and each one once. Tell me to stop any time.",
  ].join("\n");
}

export function forwardRuleSummary(rule) {
  return `start forwarding ${rule.about.slice(0, 80)} to ${rule.to}`;
}

/** The rules kept now, `[]` when there are none or the file cannot be read. */
export async function readRules(store) {
  try {
    const object = await getWithLegacyFallback(store, RULES_KEY);
    if (!object) return [];
    const kept = JSON.parse(await object.text());
    return Array.isArray(kept?.rules) ? kept.rules.filter((rule) => rule && typeof rule.routine === "string" && typeof rule.to === "string") : [];
  } catch {
    return [];
  }
}

async function writeRules(store, rules) {
  await store.put(RULES_KEY, JSON.stringify({ rules }));
}

/**
 * `forward_rule` itself: a start runs only as the approved replay
 * (`forwardRuleGate` holds it first), a stop runs at once.
 */
export async function toolForwardRule(store, args) {
  const read = readForwardRule(args);
  if (read.error) return toolError(`Not changed: ${read.error}`);
  const rules = await readRules(store);
  if (read.stop) {
    const left = rules.filter((rule) => rule.routine !== read.stop);
    if (left.length === rules.length) return toolText(`Nothing to stop: no forwarding is kept for ${read.stop}.`);
    await writeRules(store, left);
    return toolText(`Stopped: ${read.stop} no longer forwards anything. The routine note is still there; delete it too if it should not run.`);
  }
  const others = rules.filter((rule) => rule.routine !== read.rule.routine);
  if (others.length >= MAX_RULES) return toolError(`Not changed: at most ${MAX_RULES} standing forwards. Stop one first.`);
  const kept = { ...read.rule, userId: store?.actor?.userId ?? null, createdAt: new Date().toISOString(), forwarded: [] };
  await writeRules(store, [...others, kept]);
  return toolText(`Kept: ${read.rule.routine} may forward ${read.rule.about} to ${read.rule.to} without asking.`);
}

/**
 * A routine's `send_email` under a standing forward: the result when this
 * routine has a rule (sent, or refused saying why), or null when it has none
 * and the email gate goes on as before.
 */
export async function standingForward(store, session, supplied, email) {
  const routine = session.actorClientId === ROUTINES_CLIENT_ID ? session.egress?.routine : null;
  if (typeof routine !== "string" || routine === "") return null;
  const rules = await readRules(store);
  const rule = rules.find((entry) => entry.routine === routine);
  if (rule === undefined) return null;
  const only = `Not sent: this routine may only forward one of the person's emails, by its id in forward, to ${rule.to} alone.`;
  if (!email.forward || email.to.length !== 1 || email.cc.length !== 0 || email.to[0] !== rule.to) return toolError(only);
  // The rule is a yes to forwarding their own mail, and the person reads only
  // the rule's own words. A browse download is a file from a web page, fetched
  // in that page with their cookies, which no rule can have shown them — the
  // email gate refuses one on a texted yes for the same reason (`emailGate.js`,
  // "whose contents no offer can have shown"), and a rule shows less than that.
  if ((email.attach?.length ?? 0) > 0) {
    return toolError("Not sent: a standing forward passes on one of the person's emails and nothing else. Ask them about an email with files attached.");
  }
  const named = parseEmailId(String(supplied.forward).trim());
  const id = `${named.address}/${named.messageId}`;
  if (rule.forwarded.includes(id)) return toolError("Not sent: this email was already forwarded under this rule. Skip it.");
  const sent = await toolSendEmail(store, supplied);
  if (sent?.isError === true) return sent;
  // Remembered after it went, so a send that failed can be tried again on the next run.
  const now = await readRules(store);
  await writeRules(
    store,
    now.map((entry) => (entry.routine === routine ? { ...entry, forwarded: [...(entry.forwarded ?? []), id].slice(-MAX_REMEMBERED) } : entry)),
  );
  return sent;
}

/**
 * What a routine's run adds to its tools for a standing forward: `send_email`
 * when this routine has a rule (the call itself is still `standingForward`'s to
 * allow), and nothing otherwise, so a routine without one still never sends.
 */
export async function standingForwardTools(store, routine, offered) {
  if (typeof routine !== "string" || routine === "") return [];
  if (!(await readRules(store)).some((rule) => rule.routine === routine)) return [];
  return offered.filter((tool) => tool.name === "send_email");
}
