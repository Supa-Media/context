/**
 * THE EGRESS GATE'S PURE HALF (`src/privacy/egress.js`): which calls widen,
 * what a turn's ledger remembers, and when a widening must wait for a person.
 * The gate's enforcement, end to end through the worker, is
 * `agentEgress.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalRequired,
  markUntrusted,
  newLedger,
  recordRead,
  wideningOf,
} from "../src/privacy/egress.js";

const RULES = [
  { prefix: "1-projects", vis: "team" },
  { prefix: "1-projects/held", vis: "private" },
  { prefix: "2-areas", vis: "private" },
  { prefix: "2-areas/shared", vis: "team" },
];
const privacy = async () => ({ rules: RULES, overrides: new Map() });
const widening = (name, args, into = null) => wideningOf(name, args, { into, privacy });

test("a share link, a website publish and an image address each widen", async () => {
  assert.equal((await widening("create_link", { path: "a.md" }))?.audience, "anyone");
  assert.equal((await widening("create_link", { path: "a", kind: "folder", audience: "members" }))?.audience, "team");
  assert.equal((await widening("write_note", { path: "a.md", share: "anyone", content: "" }))?.audience, "anyone");
  assert.equal((await widening("write_note", { path: "a.md", share: "collect", content: "" }))?.audience, "anyone");
  assert.equal((await widening("write_note", { path: "a.md", share: "members", content: "" }))?.audience, "team");
  assert.equal((await widening("write_note", { path: "website/index.md", site: { action: "publish" } }))?.audience, "anyone");
  const image = await widening("write_note", { path: "a.md", content: "", images: [{ name: "x.png", url: "https://pics.example/x.png" }] });
  assert.equal(image?.audience, "outside");
  assert.match(image.summary, /pics\.example/);
  assert.equal(await widening("report_problem", { message: "hi" }), null, "support's intake is not an address the model chose");
});

test("checking or screenshotting the site, a data image and a plain write widen nothing", async () => {
  assert.equal(await widening("write_note", { path: "website/index.md", site: { action: "status" } }), null);
  assert.equal(await widening("write_note", { path: "website/index.md", site: { action: "check" } }), null);
  assert.equal(await widening("write_note", { path: "a.md", content: "", images: [{ name: "x.png", data: "aGk=" }] }), null);
  assert.equal(await widening("write_note", { path: "1-projects/a.md", content: "hello" }), null);
  assert.equal(await widening("write_note", { path: "1-projects/a.md", content: "hello", visibility: "team" }), null);
  assert.equal(await widening("read_note", { path: "a.md" }), null);
  assert.equal(await widening("set_visibility", { path: "a.md", visibility: "private" }), null);
  assert.equal(await widening("set_folder_visibility", { path: "2-areas", visibility: "private" }), null);
  assert.equal(await widening("set_folder_visibility", { path: "2-areas", visibility: "team", dry_run: true }), null, "a dry run changes nothing");
  assert.equal(await widening("move_folder", { source: "2-areas/x", destination: "1-projects/x", confirm_team_publish: true, dry_run: true }), null);
});

test("making a note or folder team-visible, or publishing one to the team on write, widens", async () => {
  assert.equal((await widening("set_visibility", { path: "2-areas/a.md", visibility: "team" }))?.audience, "team");
  assert.equal(await widening("set_visibility", { path: "1-projects/a.md", visibility: "team" }), null, "already team");
  assert.equal((await widening("set_folder_visibility", { path: "2-areas", visibility: "team" }))?.audience, "team");
  assert.equal(await widening("set_folder_visibility", { path: "1-projects", visibility: "team" }), null, "already team");
  assert.equal(await widening("set_folder_visibility", { path: "2-areas", visibility: "inherit" }), null, "the parent is private too");
  assert.equal((await widening("set_folder_visibility", { path: "1-projects/held", visibility: "inherit" }))?.audience, "team", "a private folder under a team one");
  assert.equal(
    (await widening("write_note", { path: "2-areas/a.md", content: "", visibility: "team", confirm_team_publish: true }))?.audience,
    "team",
  );
  assert.equal(
    await widening("write_note", { path: "1-projects/a.md", content: "", visibility: "team", confirm_team_publish: true }),
    null,
    "a team write into a team folder",
  );
  assert.equal((await widening("save_context", { platform: "x", visibility: "team" }))?.audience, "team");
  assert.equal(await widening("save_context", { platform: "x", visibility: "private" }), null);
});

test("a move widens only when asked to publish into a folder more people read", async () => {
  const publish = { confirm_team_publish: true };
  assert.equal(await widening("move_note", { source: "2-areas/a.md", destination: "1-projects/a.md" }), null, "without the ask, the note keeps its visibility");
  assert.equal((await widening("move_note", { source: "2-areas/a.md", destination: "1-projects/a.md", ...publish }))?.audience, "team");
  assert.equal(await widening("move_note", { source: "1-projects/a.md", destination: "2-areas/a.md", ...publish }), null);
  assert.equal(await widening("move_note", { source: "1-projects/a.md", destination: "1-projects/b.md", ...publish }), null);
  assert.equal(await widening("move_note", { source: "2-areas/a.md", destination: "2-areas/b.md", ...publish }), null);
  assert.equal((await widening("move_folder", { source: "2-areas/x", destination: "1-projects/x", ...publish }))?.audience, "team");
  assert.equal(await widening("move_folder", { source: "2-areas/x", destination: "1-projects/x" }), null);
  assert.equal(await widening("move_folder", { source: "1-projects/x", destination: "2-areas/x", ...publish }), null);
  const batch = await widening("move_notes", {
    moves: [
      { source: "1-projects/a.md", destination: "1-projects/b.md" },
      { source: "2-areas/c.md", destination: "2-areas/shared/c.md" },
    ],
    ...publish,
  });
  assert.equal(batch?.audience, "team");
  assert.match(batch.summary, /2-areas\/c\.md/);
  assert.equal(await widening("move_note", { source: "a.md", destination: "a.md", destination_context: "@other" }), null);
  assert.equal((await widening("move_note", { source: "a.md", destination: "a.md", destination_context: "@other", ...publish }))?.audience, "team");
});

test("any write addressed into another workspace widens", async () => {
  for (const [name, args] of [
    ["write_note", { path: "a.md", content: "" }],
    ["save_context", { platform: "x" }],
    ["remember", { fact: "x", kind: "stated" }],
    ["propose_note", { path: "a.md", content: "", reason: "r" }],
    ["submit_form", { path: "a.md", form: "f", values: {} }],
    ["move_note", { source: "a.md", destination: "b.md", confirm_team_publish: true }],
    ["move_folder", { source: "a", destination: "b", confirm_team_publish: true }],
  ]) {
    const result = await widening(name, args, "@other");
    assert.equal(result?.audience, "team", name);
    assert.match(result.summary, /@other/, name);
  }
});

test("a turn seen whole asks only when it read past the new audience", () => {
  const anyone = { audience: "anyone", summary: "" };
  const team = { audience: "team", summary: "" };
  const turn = (ledger) => ({ complete: true, ledger });

  const clean = newLedger();
  assert.equal(approvalRequired(turn(clean), anyone, "ws"), false, "nothing read: the person's own words");
  assert.equal(approvalRequired(turn(clean), null, "ws"), false, "no widening never asks");

  const listed = newLedger();
  recordRead(listed, { name: "list_notes", args: {}, scope: "private", workspaceId: "ws", result: { content: [{ type: "text", text: "a.md" }] } });
  assert.equal(approvalRequired(turn(listed), anyone, "ws"), false, "a listing is not content");

  const teamRead = newLedger();
  recordRead(teamRead, { name: "read_note", args: { path: "1-projects/a.md" }, scope: "team", workspaceId: "ws", result: { content: [{ type: "text", text: "x" }] } });
  assert.equal(approvalRequired(turn(teamRead), team, "ws"), false, "team to team is not wider");
  assert.equal(approvalRequired(turn(teamRead), anyone, "ws"), true, "team to anyone is");

  const privateRead = newLedger();
  recordRead(privateRead, { name: "read_note", args: { path: "2-areas/a.md" }, scope: "private", workspaceId: "ws", result: { content: [{ type: "text", text: "x" }] } });
  assert.equal(approvalRequired(turn(privateRead), team, "ws"), true, "private to team is wider");
  assert.equal(approvalRequired(turn(privateRead), team, "ws_other"), true, "any read elsewhere is");

  const failed = newLedger();
  recordRead(failed, { name: "read_note", args: { path: "2-areas/a.md" }, scope: "private", workspaceId: "ws", result: { isError: true, content: [] } });
  assert.equal(approvalRequired(turn(failed), anyone, "ws"), false, "a refused read handed the model nothing");
});

test("anything from outside the workspace makes every widening ask", () => {
  const team = { audience: "team", summary: "" };
  const content = { content: [{ type: "text", text: "hello" }] };
  for (const name of ["read_channel_day", "read_contact", "read_meeting"]) {
    const ledger = newLedger();
    recordRead(ledger, { name, args: {}, scope: "team", workspaceId: "ws", result: content });
    assert.equal(ledger.untrusted, true, name);
    assert.equal(approvalRequired({ complete: true, ledger }, team, "ws"), true, name);
  }
  const inbox = newLedger();
  recordRead(inbox, { name: "read_note", args: { path: "0-inbox/email/me-at-example-com/2026-10-01.md" }, scope: "private", workspaceId: "ws", result: content });
  assert.equal(inbox.untrusted, true, "a mailbox day read as a note");
  const fenced = newLedger();
  recordRead(fenced, { name: "read_note", args: { path: "3-resources/x.md" }, scope: "private", workspaceId: "ws", result: { content: [{ type: "text", text: '---\ntrust: "untrusted"\n---\nhi' }] } });
  assert.equal(fenced.untrusted, true, "a note ingestion marked untrusted");
  const web = newLedger();
  markUntrusted(web);
  assert.equal(approvalRequired({ complete: true, ledger: web }, team, "ws"), true, "a web page");
});

test("a turn the gateway does not see whole always asks, and an approved replay never does", () => {
  const anyone = { audience: "anyone", summary: "" };
  assert.equal(approvalRequired(undefined, anyone, "ws"), true, "no ledger fails closed");
  assert.equal(approvalRequired({ complete: false, ledger: newLedger() }, anyone, "ws"), true);
  assert.equal(approvalRequired({ complete: true }, anyone, "ws"), true, "complete without a ledger fails closed");
  assert.equal(approvalRequired({ approved: true }, anyone, "ws"), false);
});
