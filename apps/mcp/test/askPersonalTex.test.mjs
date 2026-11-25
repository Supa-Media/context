import test from "node:test";
import assert from "node:assert/strict";

import { ASK_PERSONAL_TEX, PERSONAL_TEX_LINE, contactFieldsOf, personalTexTool } from "../../../packages/tex/gateway/agent/askPersonalTex.js";
import { ASSISTANT_SEND_ACTIONS } from "../../../packages/tex/gateway/agent/sixTools.js";
import { groupPrompt } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { addressedTo, offerLine } from "../src/tools/offerFor.js";
import { createIdentityMethods } from "../src/controlPlane/identity.js";

/**
 * ASK YOUR PERSONAL TEX (`src/agent/askPersonalTex.js`; Dev2, 2026-11-12). Asked in a group chat to fill a booking
 * form, Tex asked the person for their own name, email and phone. A group turn now asks the tagger's personal Tex:
 * their own ask runs at once with a line to the chat, and anyone else's waits for that person's own 👍 or yes.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the offer branch removed (every `as` asks at once)
 *     → "somebody else's personal Tex is never asked before their yes" fails
 *   the `guestTagger` check removed
 *     → "an invited person's tag asks nobody's personal Tex" fails
 *   `factsLines` answering every field whatever was asked
 *     → "a last name is answered with the name alone" fails
 */

const ADA = { name: "Ada Lovelace", handle: "ada", phones: ["+15555550100"], emails: ["ada@example.invalid"], google: [] };

function world({ answer = ADA, group: extra = {} } = {}) {
  const said = [];
  const asked = [];
  const ledger = { asked: [], offered: null };
  const group = { key: "chat1", from: "ada", people: ["ada", "bo"], ...extra };
  const tool = personalTexTool({
    group,
    ledger,
    asker: async () => {
      asked.push(group.from);
      return answer;
    },
  });
  const run = async (args) => (await tool.call(args)) ?? null;
  const words = (result) => result.content.map((part) => part.text).join("\n");
  return { said, asked, ledger, tool, run, words };
}

test("the tagger's own ask answers their account's facts at once, with no line texted to the chat", async () => {
  const { said, asked, run, words } = world();
  const result = await run({ what: "name, email and phone for the venue's form" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(said, [], "no code-written status line in the chat");
  assert.deepEqual(asked, ["ada"]);
  const text = words(result);
  for (const fact of ["Ada Lovelace", "+15555550100", "ada@example.invalid"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /Source: @ada's Context account/);
  assert.match(text, /Personal Tex: not asked/);
  assert.match(text, /never ask them for these again/);
  assert.match(text, /Don't write their phone number or email into the chat/);
});

// Dev2, 2026-11-25: "what is Seyi's last name?" in a group handed the group turn his phone and four emails.
test("a last name is answered with the name alone", async () => {
  const { run, words } = world();
  const text = words(await run({ what: "What is Ada's last name?" }));
  assert.match(text, /Name: Ada Lovelace/);
  assert.doesNotMatch(text, /\+1555|example\.invalid|Phone|Email/);
  // A form ask that names none gets all three.
  const phone = words(await run({ what: "her phone number for the booking" }));
  assert.match(phone, /\+15555550100/);
  assert.doesNotMatch(phone, /Ada Lovelace|example\.invalid/);
  assert.deepEqual(contactFieldsOf("details for the sign-up form"), ["name", "phone", "email"]);
  assert.deepEqual(contactFieldsOf("their email address"), ["email"]);
});

test("an account with no name says so, rather than nothing", async () => {
  const { run, words } = world({ answer: { ...ADA, name: null } });
  assert.match(words(await run({ what: "their full name" })), /Name: none/);
});

test("as naming the tagger themself is their own ask", async () => {
  const { asked, ledger, run } = world();
  await run({ as: "@Ada" });
  assert.deepEqual(asked, ["ada"]);
  assert.equal(ledger.offered, null);
});

test("somebody else's personal Tex is never asked before their yes: it is offered to them alone", async () => {
  const { said, asked, ledger, run, words } = world();
  const result = await run({ what: "email", as: "bo" });
  assert.deepEqual(asked, [], "nothing is asked of anyone's personal Tex");
  assert.deepEqual(said, []);
  assert.deepEqual(ledger.offered, { who: "bo", tool: ASK_PERSONAL_TEX, detail: "email" });
  assert.match(words(result), /only their 👍 or yes/);
  const line = offerLine(ledger.offered);
  assert.match(line, /^@bo, may I ask your personal Tex for email\?/);
  assert.ok(addressedTo(line, "bo"), "Bo's yes counts for this ask");
  assert.ok(!addressedTo(line, "ada"), "nobody else's yes does");
});

test("one offer per answer, and never beside a held ask", async () => {
  const first = world();
  await first.run({ as: "bo" });
  assert.equal((await first.run({ as: "bo" })).isError, true);
  const held = world();
  held.ledger.asked.push({ id: "ask1" });
  assert.equal((await held.run({ as: "bo" })).isError, true);
  assert.equal(held.ledger.offered, null);
});

test("someone not in the chat, or a handle that isn't one, is refused and nothing is asked", async () => {
  const { asked, ledger, run } = world();
  assert.equal((await run({ as: "cy" })).isError, true);
  assert.equal((await run({ as: "not a handle!" })).isError, true);
  assert.deepEqual(asked, []);
  assert.equal(ledger.offered, null);
});

test("an invited person's tag asks nobody's personal Tex: it acts through someone else's account", async () => {
  const { asked, said, run } = world({ group: { from: "", guestTagger: true } });
  assert.equal((await run({})).isError, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(said, []);
});

test("when their personal Tex can't answer, nothing is made up", async () => {
  const { run, words } = world({ answer: null });
  const result = await run({});
  assert.equal(result.isError, true);
  assert.doesNotMatch(words(result), /\+1555/);
});

test("offered only on a group chat's turn that can ask the control plane", () => {
  assert.equal(personalTexTool({ group: null, ledger: {}, asker: async () => ADA }), null);
  // A chat whose people share no workspace is a group like any other (Dev2, 2026-11-25: no capability split).
  assert.notEqual(personalTexTool({ group: { from: "ada", people: ["ada"], homeOnly: true }, ledger: {}, asker: async () => ADA }), null);
  assert.equal(personalTexTool({ group: { from: "ada", people: ["ada"] }, ledger: {}, asker: null }), null);
});

test("the model calls it as send ask_personal_tex, and the group words point to it", () => {
  assert.equal(ASSISTANT_SEND_ACTIONS.ask_personal_tex.tool, ASK_PERSONAL_TEX);
  assert.ok(groupPrompt({ from: "ada", people: ["ada", "bo"] }, "studio").includes(PERSONAL_TEX_LINE));
});

test("the control plane is asked with the turn's own token with asker set, and a strange answer is nobody", async () => {
  const posts = [];
  const methods = createIdentityMethods({
    post: async (path, body) => {
      posts.push({ path, body });
      return { identity: posts.length === 1 ? ADA : "Ada" };
    },
  });
  assert.deepEqual(await methods.askerIdentity("tok"), ADA);
  assert.equal(await methods.askerIdentity("tok"), null);
  assert.deepEqual(posts[0], { path: "/gateway/agent/identity", body: { accessToken: "tok", asker: true } });
});
