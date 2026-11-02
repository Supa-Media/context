/**
 * THE GOOGLE CHAT GATE, END TO END (`src/tools/googleChatGate.js`): a texted
 * Google Chat message is checked, shown whole with where it goes, and sent on
 * one yes; a routine never sends one; another AI's waits for the app; and an
 * account without Chat is told how to reconnect, never asked about.
 *
 * Driven through the worker on the egress checks' world
 * (`agentEgressFixtures.mjs`), whose control-plane stub answers
 * `/gateway/chat/send` as its flags say (`controlPlaneStub/googleChat.mjs`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `google_chat` left out of `HELD_GATES`. → `a texted Google Chat message
 *     is held, shown whole, and not sent` fails: it is sent at once.
 *  2. `googleChatGate` skipping the check. → `the place is asked about first,
 *     spending nothing` fails.
 *  3. `emailCaller` ignored in the gate. → `a routine never sends one` fails.
 *  4. The approved replay sending with `check: true` (`sendGoogleChat` given
 *     `{ check: true }` from `store.googleChat.send`). → `approving it in the
 *     app sends it, once, and not as a check` fails.
 *  5. `sendGoogleChat` answering ok without Google's ids. → `a send Google
 *     does not confirm is never told as sent` fails.
 *  6. The reply calling a setup "a new direct message". → `a send that asked
 *     for the direct conversation says so, and never calls it new` fails.
 */

import { ask, call, request, textOf, createEgressWorld, TOKEN_CONSOLE, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { readChatMessage, toolGoogleChat } from "../src/tools/googleChat.js";
import { createGoogleChatMethods } from "../src/controlPlane/googleChat.js";

const DM = { to: "sayo@example.com", text: "Hey Sayo, I'm testing Google Chat with my assistant. Ignore this." };

export async function runGoogleChatGateChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const chat = controlPlane.googleChat;
  const sends = () => chat.calls.filter((entry) => !entry.check);

  try {
    chat.flags.from = "seyi@work.example";

    model.install([{ toolCalls: [{ name: "send", args: { action: "google_chat", args: DM } }] }, { text: "I drafted a Chat to Sayo." }]);
    const asked = await ask(env, TOKEN_TEXTS, "message sayo on google chat that i'm testing my assistant");
    check(
      "a texted Google Chat message is held, shown whole, and not sent",
      asked.status === 200 &&
        sends().length === 0 &&
        pending().length === 1 &&
        (asked.body?.answer ?? "").includes(
          `Here's the Google Chat message I'd send:\n\nFrom: seyi@work.example\nTo: sayo@example.com\n\n${DM.text}\n\nGive it a 👍 and I'll send it.`,
        ),
    );
    check("the place is asked about first, spending nothing", chat.calls.length === 1 && chat.calls[0].check === true);

    const before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "one yes sends exactly that message, without a model",
      yes.status === 200 &&
        model.requests.length === before &&
        sends().length === 1 &&
        JSON.stringify(sends()[0].message) === JSON.stringify(readChatMessage(DM).message) &&
        /Google Chat message to sayo@example\.com/.test(yes.body?.answer ?? "") &&
        pending().length === 0,
    );

    // A space is shown by the name Chat gives it, never the model's.
    chat.flags.spaceName = "Portal team";
    model.install([{ toolCalls: [{ name: "google_chat", args: { space: "portal", text: "Shipping the fix tonight." } }] }, { text: "Drafted." }]);
    const space = await ask(env, TOKEN_TEXTS, "post in the portal space that we ship tonight");
    check(
      "a space message names the space as Chat does",
      (space.body?.answer ?? "").includes("In: Portal team\n\nShipping the fix tonight.") && sends().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "no");

    const routine = await call(env, TOKEN_ROUTINE, "google_chat", DM);
    const mcp = await call(env, TOKEN_MCP, "google_chat", { ...DM, text: "From another AI." });
    check(
      "a routine never sends one; another AI's waits for the app",
      routine.isError === true &&
        /may not send messages/.test(textOf(routine)) &&
        mcp.isError === true &&
        /approve this exact message in the Context app/.test(textOf(mcp)) &&
        sends().length === 1,
    );

    // The app's Approve runs the held call as a send, never a check, and the
    // asking AI's exact replay is told what Google answered, ids included.
    const appMessage = { ...DM, text: "From another AI." };
    const held = (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];
    const callsBefore = chat.calls.length;
    const approved = await request(env, TOKEN_CONSOLE, "/approvals", { id: held.find((entry) => entry.tool === "google_chat")?.id, action: "approve" });
    const ran = chat.calls.slice(callsBefore);
    const replay = await call(env, TOKEN_MCP, "google_chat", appMessage);
    const again = await call(env, TOKEN_MCP, "google_chat", appMessage);
    check(
      "approving it in the app sends it, once, and not as a check",
      approved.body?.ok === true &&
        ran.filter((entry) => !entry.check).length === 1 &&
        JSON.stringify(ran.find((entry) => !entry.check)?.message) === JSON.stringify(readChatMessage(appMessage).message) &&
        /Sent on Google Chat from seyi@work\.example to sayo@example\.com \(Google's message spaces\/AAA\/messages\/m\d+ in spaces\/AAA\)/.test(textOf(replay)) &&
        sends().length === 2 &&
        again.isError === true &&
        /approve this exact message in the Context app/.test(textOf(again)),
    );
    for (const left of (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? []) {
      await request(env, TOKEN_CONSOLE, "/approvals", { id: left.id, action: "deny" });
    }

    chat.flags.unnamed = true;
    const unnamed = { ...DM, text: "Google answers without an id." };
    await call(env, TOKEN_MCP, "google_chat", unnamed);
    const waitingOne = ((await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? []).find((entry) => entry.tool === "google_chat");
    const unconfirmed = await request(env, TOKEN_CONSOLE, "/approvals", { id: waitingOne?.id, action: "approve" });
    check(
      "a send Google does not confirm is never told as sent",
      unconfirmed.body?.ok === false &&
        /^Not confirmed: /.test(unconfirmed.body?.result ?? "") &&
        !/Sent on Google Chat|Nothing was sent/.test(unconfirmed.body?.result ?? ""),
    );
    chat.flags.unnamed = false;

    const listed = await call(env, TOKEN_MCP, "google_chat", { action: "spaces" });
    check("listing spaces is never held", listed.isError !== true && /Portal team — spaces\/AAA/.test(textOf(listed)));

    chat.flags.from = null;
    const waiting = pending().length;
    model.install([{ toolCalls: [{ name: "google_chat", args: { ...DM, text: "Second try at this message." } }] }, { text: "Reconnect first." }]);
    await ask(env, TOKEN_TEXTS, "message sayo again");
    check(
      "an account without Chat is told to reconnect, and nothing is put to the person",
      pending().length === waiting && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("connect_google"),
    );

    const bad = await call(env, TOKEN_MCP, "google_chat", { to: "sayo@example.com", space: "Portal", text: "Hi" });
    check("a message to a person and a space at once is refused before anything", bad.isError === true && /not both/.test(textOf(bad)));
  } finally {
    world.restore();
  }

  // Setup can answer a direct message that already existed, so the reply says setup was asked, never that one was made.
  const methods = createGoogleChatMethods({
    post: async () => ({ ok: true, from: "seyi@work.example", place: { person: "sayo@example.com" }, space: "spaces/OLD", message: "spaces/OLD/messages/m1", setupUsed: true }),
  });
  const setupReply = textOf(await toolGoogleChat({ googleChat: { send: (message) => methods.sendGoogleChat("t", "w", message) } }, DM));
  check(
    "a send that asked for the direct conversation says so, and never calls it new",
    /Sent on Google Chat from seyi@work\.example to sayo@example\.com \(Google's message spaces\/OLD\/messages\/m1 in spaces\/OLD; Google found no conversation by that address, so direct-conversation setup was requested\)/.test(setupReply) &&
      !/\bnew\b|created|started/i.test(setupReply),
  );
}
