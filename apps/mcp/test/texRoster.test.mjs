// Who holds each area and which bots work there, told to a 1:1 turn (`packages/tex/gateway/agent/roster.js`; Dev,
// 2026-11-27: Tex was "oblivious to the new bots, area charter flow, and mailing flow").
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ROSTER_WORKSPACES, readRoster, rosterPrompt, rosterWorkspaces } from "../../../packages/tex/gateway/agent/roster.js";

const answer = (text) => ({ content: [{ type: "text", text }] });
const ROSTER = "Who holds each area:\n- `areas/growth/` — owner @seyi, delegate Pablo (ask Pablo first) · mail `areas/growth/mail/`\n\n## Other bots here\n- Pablo (@seyi's) — holds `areas/growth/` (mail `areas/growth/mail/`)";
const EMPTY = "No area here names an owner yet.\n\n## Other bots here\nNone this connection can see.\nBots talk only in Context mail.";

test("each workspace they write in is read with orient about roster, through their own dispatch", async () => {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push([name, args]);
    if (args.context === "@acme") return answer(ROSTER);
    if (args.context === "@failing") throw new Error("down");
    return answer(EMPTY);
  };
  const contexts = [
    { name: "@quiet", kind: "personal", role: "owner", current: true },
    { name: "@acme", kind: "shared", canWrite: true },
    { name: "@readonly", kind: "shared", canWrite: false },
    { name: "@failing", kind: "shared", canWrite: true },
  ];
  const roster = await readRoster(dispatch, contexts);
  assert.deepEqual(calls.map(([, args]) => args.context), ["@quiet", "@acme", "@failing"], "their own first, never one they only read");
  assert.ok(calls.every(([name, args]) => name === "orient" && args.about === "roster"));
  assert.deepEqual(roster, [{ name: "@acme", text: ROSTER }], "a workspace with no areas or bots, or a failed read, is left out");
  const prompt = rosterPrompt(roster);
  assert.match(prompt, /In @acme:\nWho holds each area:/);
  assert.match(prompt, /Pablo \(@seyi's\) — holds `areas\/growth\/`/);
  assert.equal(rosterPrompt([]), "", "nothing to say says nothing");
});

test("at most a handful of workspaces are read", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `@w${i}`, kind: "shared", canWrite: true }));
  assert.equal(rosterWorkspaces(many).length, MAX_ROSTER_WORKSPACES);
  assert.deepEqual(rosterWorkspaces([{ name: "@x", askerOwn: true }]), [], "a group asker's own personal workspace is never read");
});
