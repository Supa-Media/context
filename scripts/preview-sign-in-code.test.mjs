import test from "node:test";
import assert from "node:assert/strict";
import { TEAM_INBOX, codeMail, main } from "./preview-sign-in-code.mjs";

const ENV = { PR: "3786", PERSONA: "alpha", RESEND_API_KEY: "re_test", CONVEX_DEPLOY_KEY: "preview:t:p|s" };

test("the code is mailed only to the team inbox, and never logged", async () => {
  const sent = [];
  const logs = [];
  const fetchImpl = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return new Response("{}", { status: 200 }); };
  await main(ENV, { fetchImpl, find: async (_key, name) => (name === "pr3786" ? "happy-otter-1" : null), issue: (email, { deployment }) => { assert.equal(email, "alpha@supa.media"); assert.equal(deployment, "happy-otter-1"); return "123456"; }, log: (l) => logs.push(l) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "https://api.resend.com/emails");
  assert.equal(sent[0][1].to, TEAM_INBOX);
  assert.match(sent[0][1].text, /123456/);
  assert.ok(!logs.join("\n").includes("123456"));
});

test("only a persona and a pull request number are accepted, and a missing preview is an error", async () => {
  const noop = { fetchImpl: async () => new Response("{}"), find: async () => "x", issue: () => "123456", log: () => {} };
  await assert.rejects(main({ ...ENV, PERSONA: "seyi" }, noop), /PERSONA/);
  await assert.rejects(main({ ...ENV, PR: "07" }, noop), /PR must/);
  await assert.rejects(main({ ...ENV, RESEND_API_KEY: "" }, noop), /RESEND_API_KEY/);
  await assert.rejects(main(ENV, { ...noop, find: async () => null }), /no preview deployment/);
  await assert.rejects(main(ENV, { ...noop, fetchImpl: async () => new Response("quotes alpha@supa.media", { status: 422 }) }), (e) => /HTTP 422/.test(e.message) && !e.message.includes("@"));
});

test("the mail links the preview's login page when the host is known", () => {
  const mail = codeMail({ pr: "7", persona: "beta", code: "654321", expiresAt: 0, routerHost: "context-router-pr7.example.workers.dev" });
  assert.match(mail.text, /https:\/\/context-router-pr7\.example\.workers\.dev\/login/);
  assert.match(mail.subject, /beta@supa\.media/);
});

test("the personas here are the seed's", async () => {
  const { PERSONAS } = await import("./preview-sign-in-code.mjs");
  const seed = await import("./preview-seed.mjs").catch(() => null);
  if (seed) assert.deepEqual(PERSONAS, seed.PERSONAS);
});
