/**
 * The v2 action table and its translation (`src/tools/v2/translate.js`,
 * `src/tools/v2/actions.js`), read by itself.
 *
 * Every row of `ACTIONS` is checked against the call it must become, by hand,
 * so a row edited wrong fails here rather than silently routing a write to
 * the wrong tool. The second half drives the worker, so the translation is
 * seen where it is decided: in `callToolForSession`, before any gate.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ACTIONS, actionOf } from "../src/tools/v2/actions.js";
import { translateV2Params } from "../src/tools/v2/translate.js";
import { advertisedSchema, coercedArguments } from "../src/tools/advertised.js";
import {
  call,
  createEgressWorld,
  request,
  textOf,
  TOKEN_CONSOLE,
  TOKEN_MCP,
  TOKEN_MEMBER_CONSOLE,
  TOKEN_MEMBER_MCP,
} from "./agentEgressFixtures.mjs";
import { approving } from "./egressApproval.mjs";

const translate = (name, args) =>
  translateV2Params({ name, arguments: args }, undefined, { schemaFor: advertisedSchema, coerce: coercedArguments });

/** The translated call, asserting the translation succeeded. */
function translated(name, args) {
  const result = translate(name, args);
  assert.equal(result.error, undefined, result.error);
  return { name: result.params.name, arguments: result.params.arguments, v2: result.v2 };
}

const refused = (name, args) => {
  const result = translate(name, args);
  assert.ok(result.error, `expected a refusal for ${name} ${JSON.stringify(args)}`);
  assert.equal(result.params, undefined);
  return result.error;
};

test("a v2 call that is not translated passes through unchanged", () => {
  const params = { name: "read_note", arguments: { path: "a.md" } };
  assert.deepEqual(translateV2Params(params, undefined, { schemaFor: advertisedSchema }), { params });
});

// --- write: one row each -----------------------------------------------------

test("write with no action saves the note, carrying path, content and expected_etag", () => {
  assert.deepEqual(
    translated("write", { path: "1-projects/a.md", content: "# A\n", expected_etag: "e1" }),
    { name: "write_note", arguments: { path: "1-projects/a.md", content: "# A\n", expected_etag: "e1" }, v2: { tool: "write", action: "save" } },
  );
});

test("write with an empty action is a save, as with no action", () => {
  assert.equal(translated("write", { action: "", path: "a.md", content: "x" }).name, "write_note");
  assert.equal(actionOf("write", { action: "" }), "save");
  assert.equal(actionOf("write", {}), "save");
});

test("write with a null action is refused, since null is not a string", () => {
  assert.ok(refused("write", { action: null, path: "a.md", content: "x" }));
});

test("write save merges its own args under the top-level note fields", () => {
  assert.deepEqual(translated("write", { path: "a.md", content: "x", args: { visibility: "private" } }).arguments, {
    visibility: "private",
    path: "a.md",
    content: "x",
  });
});

test("write comment nests its args as comment, with the path beside it", () => {
  assert.deepEqual(
    translated("write", { action: "comment", path: "a.md", args: { text: "hi", anchor: "x" } }),
    { name: "write_note", arguments: { comment: { text: "hi", anchor: "x" }, path: "a.md" }, v2: { tool: "write", action: "comment" } },
  );
});

test("write mail nests its args as mail, with the path beside it", () => {
  assert.deepEqual(translated("write", { action: "mail", path: "a.md", args: { body: "hi" } }).arguments, {
    mail: { body: "hi" },
    path: "a.md",
  });
});

test("write upload sends args.files as write_note's upload list, with the path beside it", () => {
  const files = [{ name: "x.png", sha256: "a".repeat(64), bytes: 10 }];
  assert.deepEqual(translated("write", { action: "upload", path: "a.md", args: { files } }).arguments, {
    upload: files,
    path: "a.md",
  });
});

test("write nested objects carry no path when none was given", () => {
  assert.deepEqual(translated("write", { action: "comment", args: { text: "hi" } }).arguments, { comment: { text: "hi" } });
});

test("write remember passes its args through as remember's own", () => {
  assert.deepEqual(translated("write", { action: "remember", args: { fact: "Prefers short replies.", kind: "inferred" } }), {
    name: "remember",
    arguments: { fact: "Prefers short replies.", kind: "inferred" },
    v2: { tool: "write", action: "remember" },
  });
});

test("write propose sends the note as propose_note, with its path, content and etag", () => {
  assert.deepEqual(
    translated("write", { action: "propose", path: "2-areas/x.md", content: "y", expected_etag: "e", args: { reason: "r" } }).arguments,
    { reason: "r", path: "2-areas/x.md", content: "y", expected_etag: "e" },
  );
  assert.equal(translated("write", { action: "propose", path: "a.md", content: "y", args: { reason: "r" } }).name, "propose_note");
});

test("write answer sends the form answer as submit_form", () => {
  assert.deepEqual(translated("write", { action: "answer", path: "f.md", args: { form: "intake", values: {} } }), {
    name: "submit_form",
    arguments: { form: "intake", values: {}, path: "f.md" },
    v2: { tool: "write", action: "answer" },
  });
});

test("write update_answer replaces an answer as update_submission", () => {
  assert.deepEqual(translated("write", { action: "update_answer", path: "f.md", args: { response_id: "r1" } }), {
    name: "update_submission",
    arguments: { response_id: "r1", path: "f.md" },
    v2: { tool: "write", action: "update_answer" },
  });
});

test("write retract_answer deletes an answer as retract_submission", () => {
  assert.deepEqual(translated("write", { action: "retract_answer", path: "f.md", args: { response_id: "r1" } }), {
    name: "retract_submission",
    arguments: { response_id: "r1", path: "f.md" },
    v2: { tool: "write", action: "retract_answer" },
  });
});

test("write vote goes to vote_form", () => {
  assert.deepEqual(translated("write", { action: "vote", path: "f.md", args: { response_id: "r1", vote: "up" } }), {
    name: "vote_form",
    arguments: { response_id: "r1", vote: "up", path: "f.md" },
    v2: { tool: "write", action: "vote" },
  });
});

test("write save_session saves the session as save_context, with the note fields", () => {
  assert.deepEqual(translated("write", { action: "save_session", path: "s.md", content: "c", args: { platform: "x" } }), {
    name: "save_context",
    arguments: { platform: "x", path: "s.md", content: "c" },
    v2: { tool: "write", action: "save_session" },
  });
});

test("write report_problem passes its args to report_problem", () => {
  assert.deepEqual(translated("write", { action: "report_problem", args: { message: "broken" } }), {
    name: "report_problem",
    arguments: { message: "broken" },
    v2: { tool: "write", action: "report_problem" },
  });
});

// --- manage: one row each -----------------------------------------------------

const MANAGE = [
  ["move", "move_note", { source: "a.md", destination: "b.md" }],
  ["move_many", "move_notes", { moves: [{ source: "a.md", destination: "b.md" }] }],
  ["move_folder", "move_folder", { source: "1-projects/x", destination: "2-areas/x" }],
  ["archive", "archive_note", { path: "a.md" }],
  ["visibility", "set_visibility", { path: "a.md", visibility: "team", confirm_team_publish: true }],
  ["folder_visibility", "set_folder_visibility", { path: "2-areas", visibility: "inherit", dry_run: true }],
  ["encrypt", "set_encryption", { path: "a.md", encrypted: true }],
  ["review_proposal", "review_proposal", { proposal: "p1", decision: "approve" }],
  ["suggest_destination", "suggest_destination", { content: "x" }],
  ["revoke_link", "revoke_link", { link: "l1" }],
  ["share_link", "create_link", { path: "a.md" }],
  ["vault_add", "vault_add_link", { site: "example.com" }],
  ["vault_share", "vault_share_link", { entry: "e1" }],
  ["vault_view", "vault_view_link", { entry: "e1" }],
  ["create_workspace", "create_workspace", { slug: "acme", name: "Acme", dry_run: true }],
  ["layout", "apply_layout", { template: "business" }],
  ["connect_google", "connect_google", { kind: "gmail" }],
  ["dream_now", "dream_now", {}],
];

for (const [action, tool, args] of MANAGE) {
  test(`manage ${action} carries its arguments to ${tool} unchanged`, () => {
    assert.deepEqual(translated("manage", { action, args }), { name: tool, arguments: args, v2: { tool: "manage", action } });
  });
}

test("manage website nests its args as site, with the path beside them", () => {
  assert.deepEqual(translated("manage", { action: "website", args: { action: "publish", path: "website/about.md", draft: "d1" } }), {
    name: "write_note",
    arguments: { path: "website/about.md", site: { action: "publish", draft: "d1" } },
    v2: { tool: "manage", action: "website" },
  });
});

// write_note requires a path, and manage has nowhere else to put one: before
// 2026-10-17 every manage website call without a path in args was refused
// with "missing required argument path", so no agent could check or publish.
test("manage website with no path names the website's home page, which write_note requires", () => {
  assert.deepEqual(translated("manage", { action: "website", args: { action: "status" } }).arguments, { path: "website/index.md", site: { action: "status" } });
});

test("manage with no action is refused by the advertised schema, which requires one", () => {
  assert.match(refused("manage", { args: {} }), /action/);
});

test("manage with an empty action says which actions exist", () => {
  const error = refused("manage", { action: "" });
  assert.match(error, /^manage needs an action: one of move, move_many/);
  assert.match(error, /share_link/);
});

// --- send ------------------------------------------------------------------------

test("send email is send_email with its args as they are", () => {
  const args = { to: ["jo@example.com"], subject: "Hi", body: "Hello" };
  assert.deepEqual(translated("send", { action: "email", args }), {
    name: "send_email",
    arguments: args,
    v2: { tool: "send", action: "email" },
  });
});

test("send notify is notify_me with its args as they are", () => {
  const args = { message: "It is in production.", urgency: "asked", why: "They asked to hear." };
  assert.deepEqual(translated("send", { action: "notify", args }), {
    name: "notify_me",
    arguments: args,
    v2: { tool: "send", action: "notify" },
  });
});

test("send calendar is calendar_event with its args as they are", () => {
  const args = { action: "cancel", title: "Dentist", start: "2026-10-20" };
  assert.deepEqual(translated("send", { action: "calendar", args }), {
    name: "calendar_event",
    arguments: args,
    v2: { tool: "send", action: "calendar" },
  });
});

test("send api wraps its args as the fetch of vault_list", () => {
  assert.deepEqual(translated("send", { action: "api", args: { entry: "e1", field: "API_KEY", url: "https://api.example.com/v1" } }), {
    name: "vault_list",
    arguments: { fetch: { entry: "e1", field: "API_KEY", url: "https://api.example.com/v1" } },
    v2: { tool: "send", action: "api" },
  });
});

// --- unknown and missing actions --------------------------------------------------

test("an action no row names is refused, and lists the actions that exist", () => {
  const error = refused("write", { action: "rotate_encryption_keys" });
  assert.match(error, /^write has no action "rotate_encryption_keys"\. Its actions: save, comment/);
  assert.match(error, /orient lists what each takes/);
});

test("the names the translation never reaches are unknown actions, not tools", () => {
  for (const tool of ["rotate_encryption_keys", "materialize_move", "migrate_storage_layout", "export_encryption_keys"]) {
    assert.match(refused("manage", { action: tool }), /^manage has no action/, tool);
    assert.match(refused("write", { action: tool }), /^write has no action/, tool);
    assert.match(refused("send", { action: tool }), /^send has no action/, tool);
  }
});

test("a long action name is cut to 40 characters in the refusal", () => {
  const long = "a".repeat(100);
  const error = refused("manage", { action: long });
  assert.ok(error.includes(`"${"a".repeat(40)}…"`), error);
  assert.ok(!error.includes("a".repeat(41)), "the refusal echoes more than 40 characters");
});

test("an action name of exactly 40 characters is echoed whole, with no ellipsis", () => {
  const exact = "b".repeat(40);
  const error = refused("write", { action: exact });
  assert.ok(error.includes(`"${exact}"`), error);
  assert.ok(!error.includes("…"));
});

test("an action in the wrong verb's table is an unknown action", () => {
  assert.match(refused("write", { action: "move" }), /^write has no action "move"/);
  assert.match(refused("manage", { action: "save" }), /^manage has no action "save"/);
});

// --- context and mailbox -----------------------------------------------------------

test("context given at the top of a write is carried to the translated call", () => {
  assert.deepEqual(translated("write", { path: "a.md", content: "x", context: "@other" }).arguments, {
    path: "a.md",
    content: "x",
    context: "@other",
  });
});

test("context given inside args is carried to the translated call too", () => {
  assert.equal(translated("manage", { action: "move", args: { source: "a.md", destination: "b.md", context: "@other" } }).arguments.context, "@other");
});

test("context given both top-level and inside args with different values is refused", () => {
  assert.equal(
    refused("manage", { action: "move", context: "@a", args: { source: "a.md", destination: "b.md", context: "@b" } }),
    "that call names two different values for context; pass it once.",
  );
  assert.equal(
    refused("write", { action: "remember", context: "@a", args: { fact: "x", kind: "stated", context: "@b" } }),
    "that call names two different values for context; pass it once.",
  );
});

test("context given both top-level and inside args with the same value is accepted", () => {
  const out = translated("manage", { action: "move", context: "@a", args: { source: "a.md", destination: "b.md", context: "@a" } });
  assert.equal(out.arguments.context, "@a");
});

test("mailbox at the top of the call is carried to the translated call", () => {
  assert.deepEqual(translated("write", { action: "remember", args: { fact: "x", kind: "stated" }, mailbox: "m1" }).arguments, {
    fact: "x",
    kind: "stated",
    mailbox: "m1",
  });
});

test("mailbox given both top-level and inside args with different values is refused", () => {
  assert.equal(
    refused("write", { action: "remember", mailbox: "m1", args: { fact: "x", kind: "stated", mailbox: "m2" } }),
    "that call names two different values for mailbox; pass it once.",
  );
});

test("mailbox given both ways with the same value is accepted", () => {
  assert.equal(translated("write", { action: "remember", mailbox: "m1", args: { fact: "x", kind: "stated", mailbox: "m1" } }).arguments.mailbox, "m1");
});

// --- argument types --------------------------------------------------------------

test("args sent as a JSON string are read as the object the schema gives them", () => {
  assert.deepEqual(translated("write", { action: "remember", args: '{"fact":"x","kind":"stated"}' }).arguments, {
    fact: "x",
    kind: "stated",
  });
  assert.deepEqual(translated("manage", { action: "move", args: '{"source":"a.md","destination":"b.md"}' }).arguments, {
    source: "a.md",
    destination: "b.md",
  });
});

test("args sent as text that is not JSON is refused by the schema, not guessed at", () => {
  assert.match(refused("write", { action: "remember", args: "fact: x" }), /args/);
});

test("a path or content sent as text is never reinterpreted", () => {
  assert.deepEqual(translated("write", { path: "123", content: "true" }).arguments, { path: "123", content: "true" });
});

test("a non-object arguments value is treated as no arguments", () => {
  const result = translateV2Params({ name: "write", arguments: "nope" }, undefined, { schemaFor: () => null });
  assert.deepEqual(result.params.arguments, {});
  assert.equal(result.v2.action, "save");
});

// --- the table itself -----------------------------------------------------------------

test("every row of ACTIONS names a tool, and every row is covered above", () => {
  const rows = Object.entries(ACTIONS).flatMap(([verb, actions]) => Object.keys(actions).map((action) => `${verb}.${action}`));
  const covered = new Set([
    ...["write.save", "write.comment", "write.mail", "write.upload", "write.remember", "write.propose", "write.answer", "write.update_answer", "write.retract_answer", "write.vote", "write.save_session", "write.report_problem"],
    ...MANAGE.map(([action]) => `manage.${action}`),
    ...["manage.website", "send.api", "send.email", "send.calendar", "send.notify"],
  ]);
  assert.deepEqual(rows.filter((row) => !covered.has(row)), []);
  assert.deepEqual([...covered].filter((row) => !rows.includes(row)), []);
  for (const [verb, actions] of Object.entries(ACTIONS)) {
    for (const [action, entry] of Object.entries(actions)) {
      assert.equal(typeof entry.tool, "string", `${verb}.${action}`);
      assert.equal(typeof entry.take, "function", `${verb}.${action}`);
    }
  }
});

// --- through the worker: `callToolForSession` -------------------------------------

/**
 * The fixture's grants, plus one more: an owner's client connected read-only
 * (`context:read` alone), which is what a read-only connection is.
 */
const TOKEN_READ_ONLY = `cat_v2_readonly_${"0".repeat(22)}`;

describe("v2 calls through the worker", { concurrency: false }, () => {
  let world;
  before(async () => {
    world = await createEgressWorld();
    await world.controlPlane.addGrant({
      accessToken: TOKEN_READ_ONLY,
      workspaceId: "ws_egress",
      role: "owner",
      scopes: ["context:read"],
      clientId: "mcp_client_v2_readonly",
      clientName: "Read only",
      userId: "user_egress",
    });
  });
  after(() => world?.restore());

  const tool = (token, name, args) => call(world.env, token, name, args);
  const etagOf = (result) => /\(etag ([^)\s]+)\)/.exec(textOf(result))?.[1];

  test("write saves a note, and a write with an etag the gateway never issued is refused as a conflict", async () => {
    const first = await tool(TOKEN_MCP, "write", { path: "1-projects/v2-save.md", content: "# one\n" });
    assert.equal(first.isError, undefined, textOf(first));
    assert.match(textOf(first), /^written: 1-projects\/v2-save\.md/);

    // The etag a read returns is the one a write must send back.
    const read = textOf(await tool(TOKEN_MCP, "read_note", { path: "1-projects/v2-save.md" }));
    const current = /^etag: (\S+)$/m.exec(read)?.[1];
    assert.ok(current, "the read reports its etag");
    const second = await tool(TOKEN_MCP, "write", { path: "1-projects/v2-save.md", content: "# two\n", expected_etag: current });
    assert.equal(second.isError, undefined, textOf(second));

    // An etag that was never issued for this note is a conflict, and the note
    // keeps what the other write put there. (A retained older etag is merged by
    // the collaboration engine rather than refused: `collaboration.md`.)
    const conflict = await tool(TOKEN_MCP, "write", { path: "1-projects/v2-save.md", content: "# three\n", expected_etag: "never-issued" });
    assert.equal(conflict.isError, true);
    assert.match(textOf(conflict), /^conflict: /);
    assert.match(await readBody(world, "1-projects/v2-save.md"), /# two/);
  });

  test("a read-only grant calling write is refused with the same message as calling write_note", async () => {
    const viaWrite = await tool(TOKEN_READ_ONLY, "write", { path: "1-projects/v2-ro.md", content: "# no\n" });
    const viaNamed = await tool(TOKEN_READ_ONLY, "write_note", { path: "1-projects/v2-ro.md", content: "# no\n" });
    assert.equal(viaWrite.isError, true);
    assert.equal(viaWrite.isError, viaNamed.isError);
    assert.equal(textOf(viaWrite), textOf(viaNamed));
    assert.match(textOf(viaWrite), /read-only/);
    assert.equal(world.bucket.get("1-projects/v2-ro.md"), undefined);
  });

  test("manage website reaches the website's status, not a refusal for a missing path", async () => {
    const result = await tool(TOKEN_MCP, "manage", { action: "website", args: { action: "status" } });
    assert.doesNotMatch(textOf(result), /missing required argument|unknown argument/);
    const named = await tool(TOKEN_MCP, "write_note", { path: "website/index.md", site: { action: "status" } });
    assert.equal(textOf(result), textOf(named), "the same answer write_note gives");
  });

  test("manage move moves a note, as move_note does", async () => {
    const saved = await tool(TOKEN_MCP, "write", { path: "1-projects/v2-move-from.md", content: "# moved\n" });
    assert.equal(saved.isError, undefined, textOf(saved));
    const moved = await tool(TOKEN_MCP, "manage", {
      action: "move",
      args: { source: "1-projects/v2-move-from.md", destination: "1-projects/v2-move-to.md" },
    });
    assert.equal(moved.isError, undefined, textOf(moved));
    assert.match(textOf(moved), /^moved: 1-projects\/v2-move-from\.md → 1-projects\/v2-move-to\.md/);
    const read = await tool(TOKEN_MCP, "read_note", { path: "1-projects/v2-move-to.md" });
    assert.match(textOf(read), /# moved/);
  });

  test("manage share_link from a team-tier caller is refused exactly as create_link is", async () => {
    const viaManage = await tool(TOKEN_MEMBER_MCP, "manage", { action: "share_link", args: { path: "1-projects/plan.md" } });
    const viaNamed = await tool(TOKEN_MEMBER_MCP, "create_link", { path: "1-projects/plan.md" });
    assert.equal(viaManage.isError, true);
    assert.equal(textOf(viaManage), textOf(viaNamed));
    assert.doesNotMatch(textOf(viaManage), /https?:\/\//);
  });

  test("manage visibility to team and share_link are held for approval exactly as the old names are", async () => {
    const before = world.pending().length;
    const viaManage = await tool(TOKEN_MCP, "manage", {
      action: "visibility",
      args: { path: "2-areas/fourth.md", visibility: "team" },
    });
    const viaNamed = await tool(TOKEN_MCP, "set_visibility", { path: "2-areas/fourth.md", visibility: "team" });
    assert.equal(viaManage.held, true, "held, not run");
    assert.equal(textOf(viaManage), textOf(viaNamed));
    assert.equal(world.pending().length, before + 1, "one approval waiting, not two");
    assert.equal(world.teamVisible("2-areas/fourth.md"), false);

    const linkManage = await tool(TOKEN_MCP, "manage", { action: "share_link", args: { path: "1-projects/plan.md" } });
    const linkNamed = await tool(TOKEN_MCP, "create_link", { path: "1-projects/plan.md" });
    assert.equal(linkManage.held, true);
    assert.equal(textOf(linkManage), textOf(linkNamed));
    assert.doesNotMatch(textOf(linkManage), /https?:\/\//);

    const listed = await request(world.env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const tools = listed.body.approvals.map((row) => row.tool);
    assert.ok(tools.includes("set_visibility"), "the approval names the tool it will run, not the v2 name");
    assert.ok(tools.includes("create_link"));
    assert.ok(!tools.includes("manage"));
  });

  test("manage with an action that names no row never reaches a tool it would run", async () => {
    const before = world.pending().length;
    const done = world.done().length;
    for (const action of ["rotate_encryption_keys", "materialize_move", "migrate_storage_layout"]) {
      const result = await tool(TOKEN_MCP, "manage", { action, args: {} });
      assert.equal(result.isError, true, action);
      assert.match(textOf(result), new RegExp(`^manage has no action "${action}"`), action);
    }
    assert.equal(world.pending().length, before, "nothing was held for approval");
    assert.equal(world.done().length, done, "nothing was released");
  });

  test("write into another context lands there when the caller is an editor there", async () => {
    // TOKEN_MCP owns ws_egress and edits ws_egress_team: the gate holds the
    // write into the other workspace until the person says yes, then it lands.
    const held = await tool(TOKEN_MCP, "write", { path: "notes/v2-other.md", content: "# Other\n", context: "@egress-team" });
    assert.equal(held.held, true, "held until the person approves");
    const released = await approving(
      () => tool(TOKEN_MCP, "write", { path: "notes/v2-other.md", content: "# Other\n", context: "@egress-team" }),
      { env: world.env, consoleToken: TOKEN_CONSOLE },
    );
    assert.equal(released.isError, undefined, textOf(released));
    assert.match(world.team.get("notes/v2-other.md")?.body ?? "", /# Other/);
    assert.equal(world.bucket.get("notes/v2-other.md"), undefined, "not in the caller's own context");
  });

  test("write into another context is refused when the caller is only a member there", async () => {
    // TOKEN_MEMBER_MCP is a member of @egress-team: no write there, held or not.
    const refusal = await tool(TOKEN_MEMBER_MCP, "write", { path: "notes/v2-member.md", content: "# x\n", context: "@egress-team" });
    assert.equal(refusal.isError, true);
    assert.equal(refusal.held, undefined, "refused outright, not held for a yes");
    assert.match(textOf(refusal), /^permission denied: /);
    assert.equal(world.team.get("notes/v2-member.md"), undefined);
    // Editor in @egress-editor, and so allowed to write there once approved.
    const held = await tool(TOKEN_MEMBER_MCP, "write", { path: "1-projects/v2-editor.md", content: "# y\n", context: "@egress-editor" });
    assert.equal(held.held, true);
    const released = await approving(
      () => tool(TOKEN_MEMBER_MCP, "write", { path: "1-projects/v2-editor.md", content: "# y\n", context: "@egress-editor" }),
      { env: world.env, consoleToken: TOKEN_MEMBER_CONSOLE },
    );
    assert.equal(released.isError, undefined, textOf(released));
  });

  test("a v2 call into another context is refused by the same gates as the old name", async () => {
    const viaWrite = await tool(TOKEN_MEMBER_MCP, "write", { action: "remember", args: { fact: "x", kind: "stated", context: "@egress-team" } });
    const viaNamed = await tool(TOKEN_MEMBER_MCP, "remember", { fact: "x", kind: "stated", context: "@egress-team" });
    assert.equal(viaWrite.isError, true);
    assert.equal(textOf(viaWrite), textOf(viaNamed));
  });

  test("tools/list offers a writing connection exactly the six v2 tools", async () => {
    const { body } = await request(world.env, TOKEN_MCP, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.deepEqual(body.result.tools.map((entry) => entry.name).sort(), ["fetch", "manage", "orient", "search", "send", "write"]);
  });

  test("tools/list offers a read-only connection orient, search and fetch, and nothing that writes", async () => {
    const { body } = await request(world.env, TOKEN_READ_ONLY, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.deepEqual(body.result.tools.map((entry) => entry.name).sort(), ["fetch", "orient", "search"]);
  });
});

async function readBody(world, path) {
  return world.bucket.get(path)?.body ?? "";
}

test("the six tools' own schemas name no retired tool, so a v2 app is never told to call one it lacks", () => {
  for (const name of ["orient", "search", "fetch", "write", "manage", "send"]) {
    const text = JSON.stringify(advertisedSchema(name));
    assert.doesNotMatch(text, /\bwrite_note\b/, `${name} still says write_note`);
  }
});
