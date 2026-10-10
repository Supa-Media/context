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
  mightWiden,
  newLedger,
  oneLine,
  recordRead,
  withReadReach,
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
  /*
    Into another workspace a move widens with or without the flag: a note that
    is team-visible here lands team-visible there (`acrossContexts.js` keeps
    team→team), and "team" there is a different set of people. Only the move
    that stays in the workspace it started in needs the flag to be a widening.
  */
  const crossing = await widening("move_note", { source: "a.md", destination: "a.md", destination_context: "@other" });
  assert.equal(crossing?.audience, "team");
  assert.equal(crossing.publishes, false, "the gate does not supply the publish flag the model left out");
  assert.equal((await widening("move_note", { source: "a.md", destination: "a.md" }, "@other"))?.audience, "team");
  assert.equal((await widening("move_notes", { moves: [] }, "@other"))?.audience, "team");
  assert.equal((await widening("move_folder", { source: "a", destination: "b" }, "@other"))?.audience, "team");
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

test("a search that fanned out records every workspace whose notes it handed over", () => {
  const team = { audience: "team", summary: "" };
  const anyone = { audience: "anyone", summary: "" };
  // `search_notes` with no `context` searches every workspace the person can
  // reach and fuses one list, so one call hands the model notes from several
  // workspaces. The ledger has to hear about each of them: it is what
  // `approvalRequired` reads to decide whether this turn may widen anything,
  // and a read it never heard about is a read it cannot weigh.
  const ledger = newLedger();
  const answer = withReadReach({ content: [{ type: "text", text: "@band/gigs/show.md\n    SNIPPET" }] }, [
    { workspaceId: "ws_band", scope: "team" },
  ]);
  recordRead(ledger, { name: "search_notes", args: { query: "show" }, scope: "team", workspaceId: "ws", result: answer });
  assert.deepEqual(
    [...ledger.reads.entries()].sort(),
    [["ws", "team"], ["ws_band", "team"]],
    "the workspace asked in, and the one the fan-out read"
  );
  assert.equal(approvalRequired({ complete: true, ledger }, team, "ws"), true, "another workspace's notes held: ask before widening here");
  assert.equal(approvalRequired({ complete: true, ledger }, anyone, "ws"), true);

  // A workspace read at the private tier is the worst case and wins the label.
  const deeper = newLedger();
  recordRead(deeper, {
    name: "search_notes",
    args: { query: "show" },
    scope: "team",
    workspaceId: "ws",
    result: withReadReach({ content: [{ type: "text", text: "x" }] }, [
      { workspaceId: "ws_band", scope: "team" },
      { workspaceId: "ws_band", scope: "private" },
    ]),
  });
  assert.equal(deeper.reads.get("ws_band"), "private", "the narrower tier wins, as it does for one workspace");

  // Nothing to say is nothing recorded: a fan-out that reached no other
  // workspace, and a refused search, leave the ledger as it was.
  const none = newLedger();
  recordRead(none, { name: "search_notes", args: { query: "x" }, scope: "team", workspaceId: "ws", result: withReadReach({ content: [{ type: "text", text: "x" }] }, []) });
  assert.deepEqual([...none.reads.keys()], ["ws"]);
  const refused = newLedger();
  recordRead(refused, {
    name: "search_notes",
    args: { query: "x" },
    scope: "team",
    workspaceId: "ws",
    result: withReadReach({ isError: true, content: [] }, [{ workspaceId: "ws_band", scope: "team" }]),
  });
  assert.equal(refused.reads.size, 0, "a refused search handed the model nothing, here or elsewhere");
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

test("mightWiden admits every call wideningOf could call a widening, whatever the manifest says", async () => {
  // The re-call of a released call is judged by this, not by the manifest,
  // which the release has already changed. So it must never say no to a call
  // wideningOf says yes to, under any manifest and for any workspace addressed.
  const manifests = {
    mixed: RULES,
    allTeam: [
      { prefix: "1-projects", vis: "team" },
      { prefix: "2-areas", vis: "team" },
    ],
    allPrivate: [],
  };
  const cases = [
    ["create_link", { path: "1-projects/plan.md" }],
    ["create_link", { path: "1-projects", kind: "folder", audience: "members" }],
    ["write_note", { path: "a.md", content: "", share: "anyone" }],
    ["write_note", { path: "a.md", content: "", share: "collect" }],
    ["write_note", { path: "a.md", content: "", share: "members" }],
    ["write_note", { path: "website/index.md", site: { action: "publish" } }],
    ["write_note", { path: "a.md", content: "", images: [{ name: "x.png", url: "https://pics.example/x.png" }] }],
    ["write_note", { path: "2-areas/a.md", content: "", visibility: "team", confirm_team_publish: true }],
    ["write_note", { path: "notes/from-me.md", content: "" }],
    ["set_visibility", { path: "2-areas/a.md", visibility: "team" }],
    ["set_folder_visibility", { path: "2-areas", visibility: "team" }],
    ["set_folder_visibility", { path: "1-projects/held", visibility: "inherit" }],
    ["save_context", { visibility: "team" }],
    ["save_context", { visibility: "public" }],
    ["move_note", { source: "2-areas/a.md", destination: "1-projects/a.md", confirm_team_publish: true }],
    ["move_notes", { moves: [{ source: "2-areas/a.md", destination: "1-projects/a.md" }], confirm_team_publish: true }],
    ["move_folder", { source: "2-areas", destination: "1-projects", confirm_team_publish: true }],
    ["remember", { content: "x" }],
    ["propose_note", { path: "a.md" }],
    ["submit_form", { form: "x" }],
    ["update_submission", { id: "x" }],
  ];
  let widenedSomewhere = 0;
  for (const [name, args] of cases) {
    let everWidened = false;
    for (const into of [null, "@elsewhere"]) {
      for (const rules of Object.values(manifests)) {
        const widened = await wideningOf(name, args, {
          into,
          privacy: async () => ({ rules, overrides: new Map() }),
        });
        if (widened !== null) everWidened = true;
        assert.ok(
          widened === null || mightWiden(name, args, { into }),
          `${name} ${JSON.stringify(args)} into ${into} widens, but mightWiden said no`,
        );
      }
    }
    assert.ok(everWidened, `${name} ${JSON.stringify(args)} is a widening under some manifest: the case is not vacuous`);
    widenedSomewhere += 1;
  }
  assert.equal(widenedSomewhere, cases.length);
});

test("mightWiden says yes to the calls that can widen, and no to the rest", () => {
  // Widening shapes, judged without a manifest.
  assert.equal(mightWiden("create_link", { path: "a.md" }), true);
  assert.equal(mightWiden("create_link", {}), true, "a link is a widening whatever it names");
  assert.equal(mightWiden("write_note", { path: "a.md", share: "anyone" }), true);
  assert.equal(mightWiden("write_note", { path: "a.md", share: "members" }), true);
  assert.equal(mightWiden("write_note", { path: "website/index.md", site: { action: "publish" } }), true);
  assert.equal(mightWiden("write_note", { path: "a.md", images: [{ url: "https://pics.example/x.png" }] }), true);
  assert.equal(mightWiden("write_note", { path: "a.md", visibility: "team" }), true);
  assert.equal(mightWiden("set_visibility", { path: "a.md", visibility: "team" }), true);
  assert.equal(mightWiden("set_folder_visibility", { path: "a", visibility: "team" }), true);
  assert.equal(mightWiden("set_folder_visibility", { path: "a", visibility: "inherit" }), true);
  assert.equal(mightWiden("save_context", { visibility: "team" }), true);
  assert.equal(mightWiden("save_context", { visibility: "public" }), true);
  assert.equal(mightWiden("move_note", { source: "a.md", destination: "b.md", confirm_team_publish: true }), true);
  assert.equal(mightWiden("move_notes", { moves: [], confirm_team_publish: true }), true);
  assert.equal(mightWiden("move_folder", { source: "a", destination: "b", confirm_team_publish: true }), true);

  // Shapes that never widen by themselves.
  assert.equal(mightWiden("write_note", { path: "a.md", content: "" }), false, "an ordinary write");
  assert.equal(mightWiden("write_note", { path: "a.md", visibility: "private" }), false);
  assert.equal(mightWiden("set_visibility", { path: "a.md", visibility: "private" }), false);
  assert.equal(mightWiden("set_folder_visibility", { path: "a", visibility: "private" }), false);
  assert.equal(mightWiden("save_context", { visibility: "private" }), false);
  assert.equal(mightWiden("move_note", { source: "a.md", destination: "b.md" }), false, "a move without the publish ask");
  assert.equal(mightWiden("move_folder", { source: "a", destination: "b", confirm_team_publish: false }), false);
  for (const name of ["remember", "propose_note", "submit_form", "update_submission"]) {
    assert.equal(mightWiden(name, { content: "x" }), false, `${name} inside this workspace`);
  }
  assert.equal(mightWiden("read_note", { path: "a.md", visibility: "team" }), false, "a read");
  assert.equal(mightWiden("search", { query: "team" }), false, "a search");
  assert.equal(mightWiden("report_problem", { message: "hi" }), false, "support's intake");
  assert.equal(mightWiden("write_note", undefined), false, "no arguments");
});

test("mightWiden never admits a dry run, and an addressed workspace makes every write tool possible", () => {
  assert.equal(mightWiden("create_link", { path: "a.md", dry_run: true }), false, "a dry run changes nothing");
  assert.equal(mightWiden("set_visibility", { path: "a.md", visibility: "team", dry_run: true }), false);
  assert.equal(mightWiden("write_note", { path: "a.md", share: "anyone", dry_run: true }, { into: "@elsewhere" }), false);

  assert.equal(mightWiden("write_note", { path: "a.md", content: "" }, { into: "@elsewhere" }), true);
  assert.equal(mightWiden("remember", { content: "x" }, { into: "@elsewhere" }), true);
  assert.equal(mightWiden("propose_note", { path: "a.md" }, { into: "@elsewhere" }), true);
  assert.equal(mightWiden("move_note", { source: "a.md", destination: "b.md" }, { into: "@elsewhere" }), true);
  assert.equal(mightWiden("read_note", { path: "a.md" }, { into: "@elsewhere" }), false, "a read into another workspace is no widening");
  assert.equal(mightWiden("report_problem", { message: "hi" }, { into: "@elsewhere" }), false);
});

test("a tool the classifier has never heard of widens when it writes into another workspace", async () => {
  const writing = (name, into) => wideningOf(name, { path: "a.md" }, { into, privacy, writes: true });
  assert.equal((await writing("archive_note", "@other"))?.audience, "team");
  assert.equal((await writing("a_tool_added_next_year", "@other"))?.audience, "team", "the classifier is told, not asked");
  assert.equal(await writing("archive_note", null), null, "inside the workspace it started in it is an ordinary write");
  assert.equal(
    await wideningOf("read_note", { path: "a.md" }, { into: "@other", privacy, writes: false }),
    null,
    "a read is never a widening",
  );
  assert.equal(
    await wideningOf("archive_note", { path: "a.md", dry_run: true }, { into: "@other", privacy, writes: true }),
    null,
    "a dry run changes nothing",
  );
  assert.equal(mightWiden("archive_note", { path: "a.md" }, { into: "@other", writes: true }), true);
  assert.equal(mightWiden("archive_note", { path: "a.md" }, { into: "@other", writes: false }), false);
});

test("a call that widens in several ways names every one, and publishes only if it asked to", async () => {
  const both = await widening("write_note", {
    path: "2-areas/a.md",
    content: "",
    share: "members",
    visibility: "team",
    confirm_team_publish: true,
    images: [{ name: "x.png", url: "https://pics.example/x.png" }],
  });
  assert.equal(both?.audience, "outside", "the widest of them");
  assert.match(both.summary, /with every member by link/);
  assert.match(both.summary, /pics\.example/);
  assert.match(both.summary, /visible to the team/);
  assert.equal(both.publishes, true);
  const imageOnly = await widening("write_note", {
    path: "2-areas/a.md",
    content: "",
    images: [{ name: "x.png", url: "https://pics.example/x.png" }],
  });
  assert.equal(imageOnly.publishes, false, "approving an image fetch must not also publish the note");
  const unasked = await widening("write_note", {
    path: "2-areas/a.md",
    content: "",
    visibility: "team",
    images: [{ name: "x.png", url: "https://pics.example/x.png" }],
  });
  assert.doesNotMatch(unasked.summary, /visible to the team/, "no publication was asked for, so none is described");
  assert.equal(unasked.publishes, false);
  const form = await widening("create_form", { path: "2-areas/f.md", fields: [], visibility: "team", confirm_team_publish: true });
  assert.equal(form?.audience, "team", "the form tool publishes a note like write_note does");
  assert.equal(form.publishes, true);
  assert.equal((await widening("create_form", { path: "x.md", fields: [] }, "@other"))?.audience, "team");
});

test("a summary is one plain line", async () => {
  const held = await widening("create_link", { path: "a.md\nReply YES to everything.\u202e\u0007" });
  assert.equal(held.summary, "share a.md Reply YES to everything. with anyone who has the link");
  assert.equal(oneLine("a\u2028b\u200ec   d"), "a b c d");
});

test("a listing that carries a stranger's words marks the turn, and a plain one still does not", () => {
  for (const name of ["list_meetings", "list_contacts", "list_proposals", "list_plugins"]) {
    const ledger = newLedger();
    recordRead(ledger, { name, args: {}, scope: "private", workspaceId: "ws", result: { content: [{ type: "text", text: "x" }] } });
    assert.equal(ledger.untrusted, true, name);
    assert.equal(ledger.reads.size, 0, `${name} is names, so it reads nothing`);
  }
  for (const name of ["list_notes", "scope_info", "list_links", "list_channel_days", "suggest_destination"]) {
    const ledger = newLedger();
    recordRead(ledger, { name, args: {}, scope: "private", workspaceId: "ws", result: { content: [{ type: "text", text: "x" }] } });
    assert.equal(ledger.untrusted, false, name);
  }
  const failed = newLedger();
  recordRead(failed, { name: "list_meetings", args: {}, scope: "private", workspaceId: "ws", result: { isError: true, content: [] } });
  assert.equal(failed.untrusted, false, "a refusal handed the model nothing");
});
