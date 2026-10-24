/**
 * A STANDING FORWARD, END TO END (`src/tools/forwardRule.js`,
 * `forwardRuleGate.js`): one 👍 lets one routine keep forwarding one kind of
 * mail to one address, and nothing else (Dev2, 2026-10-21: "consistently
 * handle all of my receipts, no need for asking for approval each time").
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `standingForward` not checking the address. → `a routine's forward to
 *     any other address is refused` fails.
 *  2. `standingForward` not remembering what it forwarded. → `the same email
 *     is never forwarded twice` fails.
 *  3. `forwardRuleGate` letting a start through unheld. → `a texted rule is
 *     held, shown, and not kept` fails.
 *  4. `standingForward` not checking `attach`. → `a standing forward carries
 *     no file the person never saw` fails.
 */

import { ask, call, request, textOf, createEgressWorld, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { RULES_KEY } from "../src/tools/forwardRule.js";

const ROUTINE = "tex/routines/hourly/forward-receipts.md";
const RULE = { action: "start", routine: ROUTINE, to: "books@receipts.example", about: "receipts and invoices" };
const FORWARD = {
  to: ["books@receipts.example"],
  subject: "Fwd: Your receipt from Anthropic #2508-0278-2435",
  body: "Forwarded automatically.",
  forward: "email:seyi@gmail.example/18rcpt",
};

export async function runForwardRuleChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane, bucket } = world;
  const sends = () => controlPlane.emailCalls.filter((entry) => !entry.check);
  const rules = () => JSON.parse(bucket.get(RULES_KEY)?.body ?? '{"rules":[]}').rules;
  const run = (calls, text = "Forwarded it.") => {
    model.install([...(calls.length > 0 ? [{ toolCalls: calls }] : []), { text }]);
    return request(env, TOKEN_ROUTINE, "/agent", { routine: { path: ROUTINE } });
  };
  const forwardCall = (args) => ({ name: "send", args: { action: "email", args } });

  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";
    controlPlane.flags.mailMessage = {
      address: "seyi@gmail.example",
      id: "18rcpt",
      from: "Anthropic <invoice@billing.example>",
      subject: "Your receipt from Anthropic #2508-0278-2435",
      body: "Paid $212.00.",
      attachments: [{ filename: "Receipt-2508-0278-2435.pdf", contentType: "application/pdf" }],
    };
    bucket.set(ROUTINE, { body: "Forward new receipts and invoices in my mail to books@receipts.example. SKIP when there are none.\n", etag: "r1" });

    // Before any rule, a routine's send is refused as it always was.
    let before = sends().length;
    await run([forwardCall(FORWARD)]);
    check("with no rule, a routine never sends", sends().length === before && rules().length === 0);

    model.install([{ toolCalls: [{ name: "send", args: { action: "forward_rule", args: RULE } }] }, { text: "I'll keep forwarding your receipts to Relay." }]);
    const asked = await ask(env, TOKEN_TEXTS, "just handle all my receipts, forward them to books@receipts.example from now on");
    const shown = asked.body?.verbatim?.[0] ?? "";
    check(
      "a texted rule is held, shown, and not kept",
      rules().length === 0 &&
        pending().length === 1 &&
        shown.startsWith("Here's what I'd keep doing:") &&
        shown.includes("forward receipts and invoices from your mail to books@receipts.example") &&
        shown.endsWith("Give it a 👍 and I'll start."),
    );
    const liked = await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: shown, tapback: "Liked", conversation: "texts" });
    check(
      "its 👍 keeps the rule",
      rules().length === 1 && rules()[0].routine === ROUTINE && rules()[0].to === "books@receipts.example" &&
        liked.body?.answer === "Done, I started forwarding receipts and invoices to books@receipts.example.",
    );

    before = sends().length;
    await run([forwardCall(FORWARD)]);
    check(
      "its routine then forwards without asking",
      sends().length === before + 1 && sends().at(-1)?.email?.forward === "18rcpt" && pending().length === 0,
    );
    await run([forwardCall(FORWARD)]);
    check("the same email is never forwarded twice", sends().length === before + 1);

    await run([forwardCall({ ...FORWARD, forward: "email:seyi@gmail.example/18a", to: ["someone@elsewhere.example"] })]);
    await run([forwardCall({ ...FORWARD, forward: "email:seyi@gmail.example/18b", to: ["books@receipts.example", "someone@elsewhere.example"] })]);
    await run([forwardCall({ to: ["books@receipts.example"], subject: "Hi", body: "A plain email." })]);
    check("a routine's forward to any other address is refused, and so is anything but a forward", sends().length === before + 1);

    /*
      2026-10-24: the rule pins the recipient and nothing else about what goes
      out. `attach` carries a file a browse step downloaded from the web with
      the person's own cookies, and the email gate already refuses to let a
      texted yes cover attachments ("whose contents no offer can have shown").
      A standing forward shows even less — the person agreed to words about
      their own mail — so it carries no attachments either.

      The kept file is planted so the check tests the rule and not the id: a
      `download:` id that resolves to nothing is refused on its way to Gmail,
      which would pass this check with the guard missing.
    */
    const kept = `${Date.now()}-l-${"a".repeat(32)}`;
    bucket.set(`.context/agent/downloads/${kept}.json`, {
      body: JSON.stringify({ name: "statement.pdf", type: "application/pdf", data: "SGVsbG8=" }),
      etag: "d1",
    });
    await run([forwardCall({ ...FORWARD, forward: "email:seyi@gmail.example/18att", attach: [`download:${kept}`] })]);
    check("a standing forward carries no file the person never saw", sends().length === before + 1);

    const other = "tex/routines/hourly/other.md";
    bucket.set(other, { body: "Forward everything.\n", etag: "r2" });
    model.install([{ toolCalls: [forwardCall({ ...FORWARD, forward: "email:seyi@gmail.example/18other" })] }, { text: "Done." }]);
    await request(env, TOKEN_ROUTINE, "/agent", { routine: { path: other } });
    check("another routine has no rule and still never sends", sends().length === before + 1);

    const routineAsks = await call(env, TOKEN_ROUTINE, "forward_rule", { ...RULE, routine: other });
    const otherAi = await call(env, TOKEN_MCP, "forward_rule", { ...RULE, routine: other });
    check(
      "a routine can't make itself a rule; another AI's waits for the app",
      routineAsks.isError === true && /only the person/.test(textOf(routineAsks)) && /Context app/.test(textOf(otherAi)) && rules().length === 1,
    );

    model.install([{ toolCalls: [{ name: "send", args: { action: "forward_rule", args: { action: "stop", routine: ROUTINE } } }] }, { text: "Stopped." }]);
    await ask(env, TOKEN_TEXTS, "stop forwarding my receipts");
    await run([forwardCall({ ...FORWARD, forward: "email:seyi@gmail.example/18next" })]);
    check("stopping takes no 👍, and the routine sends nothing after", rules().length === 0 && sends().length === before + 1);
  } finally {
    world.restore();
  }
}
