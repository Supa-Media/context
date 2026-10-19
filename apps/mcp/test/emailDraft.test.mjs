/**
 * A DRAFT IN THE PERSON'S GMAIL, END TO END: `save_email_draft` saves one
 * email in their own Drafts and sends nothing, so unlike `send_email` it runs
 * at once with no yes (`src/tools/email.js`). The control plane still picks
 * the Gmail that may keep it and holds the draft limits
 * (`apps/convex/__tests__/personEmailDraft.test.ts`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `store.email.draft` pointed at `sendPersonEmail` in `http/routing.js`.
 *     → `a texted draft is saved at once, and nothing is sent` fails.
 *  2. `save_email_draft` added to `HELD_GATES`. → the same check fails: the
 *     draft waits for a yes.
 */

import { ask, call, textOf, toolReplies, createEgressWorld, TOKEN_MCP, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const EMAIL = { to: ["jo@example.com"], subject: "Re: Thursday", body: "Hi Jo,\n\nThursday at 3 works for me." };

export async function runEmailDraftChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const drafts = () => controlPlane.emailCalls.filter((entry) => entry.draft === true);
  const sends = () => controlPlane.emailCalls.filter((entry) => entry.draft !== true);

  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";
    controlPlane.flags.emailDrafter = "seyi@gmail.example";

    model.install([
      { toolCalls: [{ name: "send", args: { action: "email_draft", args: EMAIL } }] },
      { text: "It's in your Gmail drafts." },
    ]);
    const asked = await ask(env, TOKEN_TEXTS, "draft a reply to Jo saying Thursday at 3 works");
    const replies = toolReplies(model.requests.at(-1));
    check(
      "a texted draft is saved at once, and nothing is sent",
      asked.status === 200 &&
        drafts().length === 1 &&
        JSON.stringify(drafts()[0].email) === JSON.stringify({ to: EMAIL.to, cc: [], subject: EMAIL.subject, body: EMAIL.body }) &&
        sends().length === 0 &&
        pending().length === 0 &&
        !/Just say yes/.test(asked.body?.answer ?? "") &&
        /^Saved as a draft in seyi@gmail\.example's Gmail/.test(replies[0] ?? ""),
    );

    const viaClient = await call(env, TOKEN_MCP, "save_email_draft", EMAIL);
    check(
      "an MCP client saves a draft the same way",
      viaClient.isError !== true && /Nothing was sent/.test(textOf(viaClient)) && drafts().length === 2 && sends().length === 0,
    );

    const invalid = await call(env, TOKEN_MCP, "save_email_draft", { ...EMAIL, to: ["Jo <jo@example.com>"] });
    check(
      "a draft that is not one plain email is refused before the control plane hears of it",
      invalid.isError === true && /^Not saved: to has something/.test(textOf(invalid)) && drafts().length === 2,
    );

    controlPlane.flags.emailDrafter = null;
    const none = await call(env, TOKEN_MCP, "save_email_draft", EMAIL);
    check(
      "with no Gmail that may keep drafts, it says so and to give them the draft instead",
      none.isError === true && /Give them the draft to copy instead/.test(textOf(none)),
    );
  } finally {
    world.restore();
  }
}
