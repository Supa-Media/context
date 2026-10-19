/**
 * THE SEND-REVIEW GATE, END TO END: no email leaves without the person's yes
 * to that exact copy, the Mail checker can stop one but never send one, and
 * the limits are asked about before the person is (`src/tools/emailGate.js`,
 * `src/agent/mailChecker.js`).
 *
 * Driven through the worker as a texting turn, an MCP client, a routine and
 * the app would each reach it, on the egress checks' world
 * (`agentEgressFixtures.mjs`), whose control-plane stub answers
 * `/gateway/email/send` as its flags say.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `emailGate` returning null for every call (no hold). → `a texted email
 *     is held, shown whole, and not sent` fails: the email is sent at once.
 *  3. A checker "no" treated as "unsure". → `a Mail checker no refuses it
 *     before the person is asked` fails.
 *  4. `emailCaller` treating every client as "texting-assistant". → `an MCP
 *     client may not send unless the Mail checker's note lets it` fails.
 *  5. `disarmTexting` not called before a model turn. → `a yes after the
 *     person moved on sends nothing` fails.
 *  6. The held call keeping the supplied args (no bound `from`). → `an email
 *     goes only from the mailbox the person was shown, or not at all` fails.
 *  7. Email records settled on any yes word. → `an "ok" to an email is not a
 *     yes` fails.
 *  8. No texted length cap. → `an email too long to show whole in one text is
 *     never asked about by text` fails.
 *  9. `settleByText` not disarming an email it skipped. → `an "ok" that
 *     settles another ask still disarms the email beside it` fails.
 * 10. No one-email-per-text refusal in `emailGate`. → `a second email in one
 *     texted turn is refused` fails.
 * 11. `textedAsk` without its length cap. → `an ask holding an email that
 *     outgrows one text is withdrawn, not cut` fails.
 * 12. `textedAsk` returning an ask that holds no email as prose (no
 *     `verbatim`, no cap). → `an ask holding no email is texted whole too, or
 *     withdrawn rather than cut` fails.
 * 12b. `RELEASED_YES` dropped from `strictYes`. → `a yes that says to send
 *     it ("Yes, send it") sends the email` fails.
 * 13. The gates raising holds armed (`armed: false` dropped in `emailGate`).
 *     → `a hold is armed only once its ask goes out whole` fails.
 * 14. `textedAsk` arming before its length check. → `an ask too long to send
 *     stays unarmed even when withdrawing it fails` fails.
 */

import { ask, call, request, textOf, createEgressWorld, TOKEN_CONSOLE, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { emailCaller, DEFAULT_EMAIL_CALLERS } from "../src/tools/emailGate.js";
import { helperCallersOf } from "../src/agent/production.js";
import { conversationFor, readVerdict } from "../src/agent/mailChecker.js";
import { readEmail } from "../src/tools/email.js";
import { TEXTED_ASK_CAP, textedAsk } from "../src/agent/textedApprovals.js";
import { createPending, disarmRecords, listPending } from "../src/tools/approvals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const EMAIL = { to: ["jo@example.com"], subject: "Re: Thursday", body: "Hi Jo,\n\nThursday at 3 works for me.\n\nSeyi" };
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });
const isChecker = (body) => JSON.stringify(body?.system ?? "").includes("You check one email");

export async function runEmailGateChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const sends = () => controlPlane.emailCalls.filter((entry) => !entry.check);
  const approvals = async () => (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];

  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";

    /* ---------------- a texted email ---------------- */

    model.install([
      { toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] },
      verdict("yes"),
      { text: "I drafted a reply to Jo saying Thursday works." },
    ]);
    const asked = await ask(env, TOKEN_TEXTS, "reply to Jo that Thursday at 3 works");
    const checkerRequest = model.requests.find(isChecker);
    check(
      "a texted email is held, shown whole, and not sent",
      asked.status === 200 &&
        sends().length === 0 &&
        pending().length === 1 &&
        asked.body?.asked === 1 &&
        (asked.body?.answer ?? "").includes(
          "Here's the email I'd send:\n\nFrom: seyi@gmail.example\nTo: jo@example.com\nSubject: Re: Thursday\n\nHi Jo,\n\nThursday at 3 works for me.\n\nSeyi\n\nLook good? Just say yes and I'll send it",
        ),
    );
    check(
      "the ask is texted exactly as written, apart from the answer's formatting",
      Array.isArray(asked.body?.verbatim) &&
        asked.body.verbatim.length === 1 &&
        asked.body.verbatim[0].startsWith("Here's the email I'd send:") &&
        (asked.body?.answer ?? "").endsWith(asked.body.verbatim[0]),
    );
    check(
      "the limits were asked about before the person was, without spending",
      controlPlane.emailCalls.length === 1 && controlPlane.emailCalls[0].check === true,
    );
    check(
      "the Mail checker read the person's words and the draft, and nothing a tool returned",
      checkerRequest !== undefined &&
        JSON.stringify(checkerRequest.messages).includes("PERSON: reply to Jo that Thursday at 3 works") &&
        JSON.stringify(checkerRequest.messages).includes("Thursday at 3 works for me") &&
        !JSON.stringify(checkerRequest.messages).includes("tool_result") &&
        !(checkerRequest.tools ?? []).length,
    );
    let before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a texted YES sends exactly that email, without a model",
      yes.status === 200 &&
        model.requests.length === before &&
        sends().length === 1 &&
        JSON.stringify(sends()[0].email) === JSON.stringify({ from: "seyi@gmail.example", to: EMAIL.to, cc: [], subject: EMAIL.subject, body: EMAIL.body }) &&
        /^Done, I sent an email to jo@example\.com, "Re: Thursday"\.$/.test(yes.body?.answer ?? "") &&
        pending().length === 0,
    );

    model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, { text: "Already sent." }]);
    before = sends().length;
    await ask(env, TOKEN_TEXTS, "did you send it to Jo?");
    check(
      "the same email asked for again within the hour is answered as sent, not sent twice",
      sends().length === before && pending().length === 0 && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("Sent from seyi@gmail.example"),
    );

    /* ---------------- moving on disarms it ---------------- */

    model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: Friday" } }] },
      verdict("yes"),
      { text: "Drafted." },
    ]);
    await ask(env, TOKEN_TEXTS, "actually tell Jo Friday instead");
    model.install([{ text: "Sure, what time?" }]);
    await ask(env, TOKEN_TEXTS, "hmm wait, what time did they suggest?");
    model.install([{ text: "Yes what?" }]);
    before = sends().length;
    const late = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "a yes after the person moved on sends nothing",
      sends().length === before && /Yes what/.test(late.body?.answer ?? ""),
    );
    const listed = await approvals();
    check(
      "the app still lists it, with the whole email to read",
      listed.length === 1 && listed[0].tool === "send_email" && (listed[0].detail ?? "").includes("Subject: Re: Friday"),
    );
    const approved = await request(env, TOKEN_CONSOLE, "/approvals", { id: listed[0].id, action: "approve" });
    check(
      "approving it in the app sends it once",
      approved.body?.status === "approved" && approved.body?.ok === true && sends().length === before + 1 && sends().at(-1).email.subject === "Re: Friday",
    );

    /* ---------------- the sender shown is the sender ---------------- */

    model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: sender" } }] }, verdict("yes"), { text: "Drafted." }]);
    await ask(env, TOKEN_TEXTS, "tell Jo yes");
    controlPlane.flags.emailSender = "other@gmail.example";
    before = sends().length;
    const moved = await ask(env, TOKEN_TEXTS, "YES");
    check(
      "an email goes only from the mailbox the person was shown, or not at all",
      sends().length === before + 1 &&
        sends().at(-1).email.from === "seyi@gmail.example" &&
        sends().at(-1).answer.ok === false &&
        /^I tried to send an email/.test(moved.body?.answer ?? ""),
    );
    controlPlane.flags.emailSender = "seyi@gmail.example";

    /* ---------------- a text shows it whole, or it is not asked ---------------- */

    model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: long", body: "word ".repeat(600) } }] },
      verdict("yes"),
      { text: "It was too long to text." },
    ]);
    before = pending().length;
    await ask(env, TOKEN_TEXTS, "send Jo the long version");
    check(
      "an email too long to show whole in one text is never asked about by text",
      pending().length === before && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("too long to show the person whole in a text"),
    );

    /* ---------------- only a YES sends an email ---------------- */

    model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: ok" } }] }, verdict("yes"), { text: "Drafted." }]);
    await ask(env, TOKEN_TEXTS, "email Jo that it's fine");
    model.install([{ text: "Want me to send it? Reply YES." }]);
    before = sends().length;
    const okay = await ask(env, TOKEN_TEXTS, "ok");
    model.install([{ text: "Yes what?" }]);
    await ask(env, TOKEN_TEXTS, "yes");
    check(
      'an "ok" to an email is not a yes: it goes to the model and disarms the email',
      sends().length === before && /Reply YES/.test(okay.body?.answer ?? ""),
    );
    for (const left of await approvals()) await request(env, TOKEN_CONSOLE, "/approvals", { id: left.id, action: "deny" });

    model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: said so" } }] }, verdict("yes"), { text: "Drafted." }]);
    await ask(env, TOKEN_TEXTS, "email Jo that it's fine");
    before = sends().length;
    const sendIt = await ask(env, TOKEN_TEXTS, "Yes, send it");
    check(
      'a yes that says to send it ("Yes, send it") sends the email',
      sends().length === before + 1 && sends().at(-1).email.subject === "Re: said so" && /^Done: send an email/.test(sendIt.body?.answer ?? ""),
    );
    model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: changed" } }] }, verdict("yes"), { text: "Drafted." }]);
    await ask(env, TOKEN_TEXTS, "email Jo that it's fine");
    model.install([{ text: "Who should it go to?" }]);
    before = sends().length;
    const turnsBefore = model.requests.length;
    const changed = await ask(env, TOKEN_TEXTS, "yes but send it to Sam");
    check(
      "a yes that changes the email is not a yes: it goes to the model and nothing is sent",
      sends().length === before && model.requests.length === turnsBefore + 1 && /Who should it go to/.test(changed.body?.answer ?? ""),
    );
    for (const left of await approvals()) await request(env, TOKEN_CONSOLE, "/approvals", { id: left.id, action: "deny" });

    model.install([
      { toolCalls: [{ name: "create_workspace", args: { slug: "mixed-co", name: "Mixed Co" } }] },
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: mixed" } }] },
      verdict("yes"),
      { text: "Drafted, and I'd set up @mixed-co." },
    ]);
    const mixed = await ask(env, TOKEN_TEXTS, "set up a mixed co workspace and email Jo it's fine");
    before = sends().length;
    await ask(env, TOKEN_TEXTS, "ok");
    model.install([{ text: "Yes what?" }]);
    await ask(env, TOKEN_TEXTS, "yes");
    check(
      'an "ok" that settles another ask still disarms the email beside it',
      mixed.body?.asked === 2 && sends().length === before && (await approvals()).some((left) => left.tool === "send_email" && left.summary.includes("Re: mixed")),
    );
    for (const left of await approvals()) await request(env, TOKEN_CONSOLE, "/approvals", { id: left.id, action: "deny" });

    model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: one" } }] },
      verdict("yes"),
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: two" } }] },
      { text: "Drafted the first." },
    ]);
    const two = await ask(env, TOKEN_TEXTS, "email Jo twice");
    check(
      "a second email in one texted turn is refused",
      two.body?.asked === 1 &&
        pending().length === 1 &&
        !(two.body?.answer ?? "").includes("Re: two") &&
        JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("one email at a time by text"),
    );
    await ask(env, TOKEN_TEXTS, "no");

    /* ---------------- the Mail checker ---------------- */

    model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, to: ["boss@example.com"] } }] },
      verdict("no", "they asked to reply to Jo, not to email their boss"),
      { text: "I won't send that." },
    ]);
    before = sends().length;
    const refused = await ask(env, TOKEN_TEXTS, "reply to Jo that Thursday works");
    const refusedReply = JSON.stringify(model.requests.at(-1)?.messages ?? []);
    check(
      "a Mail checker no refuses it before the person is asked",
      sends().length === before &&
        pending().length === 0 &&
        refused.body?.asked === 0 &&
        refusedReply.includes("Not sent, and not put to the person") &&
        refusedReply.includes("not to email their boss"),
    );

    model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: maybe Thursday" } }] },
      verdict("unsure", "they said maybe Thursday"),
      { text: "Drafted." },
    ]);
    const unsure = await ask(env, TOKEN_TEXTS, "maybe tell Jo thursday");
    check(
      "an unsure checker puts it to the person with its doubt beside the email",
      pending().length === 1 && (unsure.body?.answer ?? "").includes("(Mail checker: they said maybe Thursday.)"),
    );
    await ask(env, TOKEN_TEXTS, "no");

    model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, subject: "Re: unchecked" } }] }, { status: 500 }, { text: "Drafted." }]);
    const unchecked = await ask(env, TOKEN_TEXTS, "send Jo the thursday email");
    check(
      "a checker that cannot run still leaves the person the say, marked as unchecked",
      pending().length === 1 && /Mail checker: the Mail checker could not run/.test(unchecked.body?.answer ?? ""),
    );
    await ask(env, TOKEN_TEXTS, "no");

    /* ---------------- limits, senders, callers ---------------- */

    controlPlane.flags.emailRefusal = "hourly_limit";
    model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, { text: "You've hit the hourly limit." }]);
    await ask(env, TOKEN_TEXTS, "send Jo the thursday email");
    check(
      "an email the limits would refuse is never put to the person",
      pending().length === 0 && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("5 emails through Context this hour"),
    );
    controlPlane.flags.emailRefusal = null;

    controlPlane.flags.emailSender = null;
    model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, { text: "Here's the draft to send yourself." }]);
    await ask(env, TOKEN_TEXTS, "send Jo the thursday email");
    check(
      "with no Gmail that may send, the model is told to hand over the draft",
      pending().length === 0 && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("give them the draft to copy"),
    );
    controlPlane.flags.emailSender = "seyi@gmail.example";

    before = controlPlane.emailCalls.length;
    const mcp = await call(env, TOKEN_MCP, "send", { action: "email", args: EMAIL });
    check(
      "an MCP client may not send unless the Mail checker's note lets it",
      mcp.isError === true && /not allowed to send email/.test(textOf(mcp)) && controlPlane.emailCalls.length === before && pending().length === 0,
    );
    const routine = await call(env, TOKEN_ROUTINE, "send_email", EMAIL);
    check("a routine never sends email", routine.isError === true && controlPlane.emailCalls.length === before);
    const elsewhere = await call(env, TOKEN_MCP, "send_email", { ...EMAIL, context: "@egress-team" });
    check("send_email takes no context", elsewhere.isError === true && /takes no context/.test(textOf(elsewhere)));

  } finally {
    world.restore();
  }

  /* ---------------- the pure parts ---------------- */

  const memory = createMemoryStore();
  const actor = { userId: "u1", clientId: "context_texts" };
  const hold = (detail, summary, name = detail ? "send_email" : "set_visibility") =>
    createPending(memory, { name, args: { summary }, actor, widening: { summary }, detail, texting: true });
  const short = [await hold("To: jo@example.com\n\nshort", "email jo")];
  const fits = await textedAsk(memory, { actorUserId: "u1" }, short);
  const long = [await hold("x".repeat(2_450), "email jo again"), ...(await Promise.all(Array.from({ length: 20 }, (_, i) => hold(undefined, `share note ${i} with the team`))))];
  const outgrown = await textedAsk(memory, { actorUserId: "u1" }, long);
  check(
    "an ask holding an email that outgrows one text is withdrawn, not cut",
    fits.verbatim.length === 1 &&
      fits.verbatim[0] === fits.ask &&
      outgrown.verbatim.length === 0 &&
      !outgrown.ask.includes("xxxx") &&
      outgrown.ask.length < TEXTED_ASK_CAP &&
      long.length === 0 &&
      (await listPending(memory, { userId: "u1" })).length === 1 &&
      TEXTED_ASK_CAP < 3_000,
  );

  /*
    AN ASK HOLDING NO EMAIL GOES OUT WHOLE TOO.

    A handle claim is the one ask the deployment switch still makes
    (`src/tools/session.js`), and it holds no email, so it used to be handed
    back as part of the answer rather than as a text of its own. Glued to the
    end of a long answer the formatter cuts it: `apps/agent/src/format.ts`
    keeps three texts and folds every later paragraph into the third, and
    `apps/agent/src/clients.ts` sends at most 3,000 characters of each. The
    record stays armed for half an hour either way, so a bare "yes" afterwards
    releases a claim the person never read — and a claimed handle is never
    given back.
  */
  const claimSummary = "claim the handle @acme for a new shared workspace (handles are permanent)";
  const claim = [await hold(undefined, claimSummary, "create_workspace")];
  const claimed = await textedAsk(memory, { actorUserId: "u1" }, claim);
  const spill = await Promise.all(
    Array.from({ length: 12 }, (_, i) => hold(undefined, `share note ${i} with the team ${"y".repeat(300)}`)),
  );
  const spilled = await textedAsk(memory, { actorUserId: "u1" }, spill);
  check(
    "an ask holding no email is texted whole too, or withdrawn rather than cut",
    claimed.verbatim.length === 1 &&
      claimed.verbatim[0] === claimed.ask &&
      claimed.ask.includes(claimSummary) &&
      spilled.verbatim.length === 0 &&
      !spilled.ask.includes("yyyy") &&
      spilled.ask.length < TEXTED_ASK_CAP &&
      spill.length === 0 &&
      (await listPending(memory, { userId: "u1" })).length === 2,
  );

  /*
    A HOLD IS ARMED ONLY ONCE ITS ASK GOES OUT WHOLE (Codex, re-reviewing
    #1826): withdrawing an ask that would not fit, and disarming one the
    person moved on from, both swallow storage errors, so a record left armed
    by a failed delete would be released by the next bare "yes".
  */
  const lazy = createMemoryStore();
  const raise = (summary, detail) =>
    createPending(lazy, { name: detail ? "send_email" : "set_visibility", args: { summary }, actor, widening: { summary }, detail, texting: true, armed: false });
  const armedFor = async (store) => (await listPending(store, { userId: "u1", texting: true })).length;
  const one = [await raise("email jo", "To: jo@example.com\n\nshort")];
  const unarmedBefore = await armedFor(lazy);
  await textedAsk(lazy, { actorUserId: "u1" }, one);
  check("a hold is armed only once its ask goes out whole", unarmedBefore === 0 && (await armedFor(lazy)) === 1);
  await lazy.delete((await listPending(lazy, { userId: "u1" }))[0].key);

  const failing = (store, fail) => new Proxy(store, { get: (target, prop) => (fail.has(prop) ? async () => { throw new Error("storage down"); } : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
  const tooLong = [await raise("email jo again", "x".repeat(2_450)), ...(await Promise.all(Array.from({ length: 20 }, (_, i) => raise(`share note ${i} with the team`))))];
  const dropped = await textedAsk(failing(lazy, new Set(["delete"])), { actorUserId: "u1" }, tooLong);
  const brokenArm = [await raise("email kim", "To: kim@example.com\n\nhi")];
  const notPut = await textedAsk(failing(lazy, new Set(["put", "delete"])), { actorUserId: "u1" }, brokenArm);
  check(
    "an ask too long to send stays unarmed even when withdrawing it fails",
    dropped.verbatim.length === 0 &&
      (await listPending(lazy, { userId: "u1" })).length === 22 &&
      (await armedFor(lazy)) === 0 &&
      notPut.verbatim.length === 0 &&
      brokenArm.length === 0 &&
      (await armedFor(lazy)) === 0,
  );

  const stuckStore = createMemoryStore();
  await createPending(stuckStore, { name: "send_email", args: { summary: "s" }, actor, widening: { summary: "s" }, detail: "To: jo@example.com", texting: true });
  const stuck = await disarmRecords(failing(stuckStore, new Set(["put", "delete"])), await listPending(stuckStore, { userId: "u1", texting: true }));
  const cleared = await disarmRecords(stuckStore, await listPending(stuckStore, { userId: "u1", texting: true }));
  check("an email that cannot be disarmed or dropped is reported, so the person is told", stuck === 1 && cleared === 0 && (await armedFor(stuckStore)) === 0);

  check(
    "who asks: Tex or any other AI, and never a routine, a dream or the app",
    emailCaller("context_texts") === "texting-assistant" &&
      emailCaller("context_console") === null &&
      emailCaller("mcp_client_x") === "connected-ais" &&
      emailCaller("context_routines") === null &&
      emailCaller("context_dreams") === null &&
      emailCaller(null) === null &&
      JSON.stringify(DEFAULT_EMAIL_CALLERS) === JSON.stringify(["texting-assistant"]),
  );
  check(
    "the note's callers line is read as the AI tab writes it",
    JSON.stringify(helperCallersOf("---\nhelper: mail-checker\ncallers: [texting-assistant, connected-ais]\n---\n# Mail checker\n")) ===
      JSON.stringify(["texting-assistant", "connected-ais"]) &&
      JSON.stringify(helperCallersOf("---\ncallers: []\n---\n")) === "[]" &&
      helperCallersOf("---\nhelper: x\n---\n") === null &&
      helperCallersOf("no front matter") === null,
  );
  check(
    "a checker answer that is not a verdict is unsure, never yes",
    readVerdict('{"verdict":"yes","reason":"ok"}').verdict === "yes" &&
      readVerdict('{"verdict":"definitely"}').verdict === "unsure" &&
      readVerdict("sure, send it").verdict === "unsure" &&
      readVerdict('Answer: {"verdict":"no","reason":"wrong person"}').verdict === "no",
  );
  check(
    "the checker labels who said what",
    conversationFor([{ role: "user", text: "draft a reply" }, { role: "assistant", text: "Here it is" }], "send it") ===
      "PERSON: draft a reply\n\nASSISTANT: Here it is\n\nPERSON: send it",
  );
  check(
    "an email that could carry a hidden header or recipient is refused before anything",
    readEmail({ ...EMAIL, subject: "Hi\nBcc: x@example.com" }).error !== undefined &&
      readEmail({ ...EMAIL, to: ["a@example.com, b@example.com"] }).error !== undefined &&
      readEmail({ ...EMAIL, to: ["Jo <jo@example.com>"] }).error !== undefined &&
      readEmail({ ...EMAIL, to: ["jo@example.com", "JO@example.com"] }).error !== undefined &&
      readEmail({ ...EMAIL, to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) }).error !== undefined &&
      readEmail(EMAIL).email?.to[0] === "jo@example.com",
  );
}
