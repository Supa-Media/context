import test from "node:test";
import assert from "node:assert/strict";

import { TEX_SETTINGS, WHERE } from "../../../packages/shared/src/texSettings.cjs";
import { ASSISTANT_SEND_ACTIONS } from "../src/agent/sixTools.js";
import { SETTING_HANDLERS, settingsSnapshot, settingsTools } from "../src/agent/settingsTools.js";
import { commandTools } from "../src/agent/commandTools.js";

// Dev2, 2026-11-12: "make sure that tex is privy to its settings configuration and the user can make changes in the
// chat without having to open the UI". One registry (`texSettings.cjs`); every row is changed by a tool Tex has, or
// names where in the app it changes; every switch Tex has is a row.

test("every setting row is changed by an action Tex has, or names its app path", () => {
  const keys = new Set();
  for (const row of TEX_SETTINGS) {
    assert.ok(!keys.has(row.key), `${row.key} is listed twice`);
    keys.add(row.key);
    for (const field of ["label", "description", "section"]) assert.ok(typeof row[field] === "string" && row[field] !== "", `${row.key}: ${field}`);
    assert.ok(row.where.length > 0 && row.where.every((where) => WHERE.includes(where)), `${row.key}: where`);
    if (row.byText) assert.ok(Object.hasOwn(ASSISTANT_SEND_ACTIONS, row.via), `${row.key}: send ${row.via} is not an action Tex has`);
    else assert.ok(typeof row.appPath === "string" && row.appPath !== "", `${row.key}: an app-only setting says where it changes`);
  }
});

test("the setting action's switches are exactly the registry's setting rows", () => {
  const rows = TEX_SETTINGS.filter((row) => row.via === "setting").map((row) => row.key).sort();
  assert.deepEqual(Object.keys(SETTING_HANDLERS).sort(), rows);
});

/** A note store behind the turn's tool door: `read_note` and `write_note`, with etags. */
function notes(start = {}) {
  const files = new Map(Object.entries(start));
  let n = 0;
  const etags = new Map([...files.keys()].map((path) => [path, `e${n++}`]));
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      if (!files.has(args.path)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: ${etags.get(args.path)}\n\n${files.get(args.path)}` }] };
    }
    if (name === "write_note") {
      if (files.has(args.path) && args.expected_etag !== etags.get(args.path)) return { isError: true, content: [{ type: "text", text: "conflict" }] };
      files.set(args.path, args.content);
      etags.set(args.path, `e${n++}`);
      return { content: [{ type: "text", text: "ok" }] };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { files, dispatch };
}

const session = { accessToken: "tok", workspaceId: "w1", flags: [], workspaces: [{ workspaceId: "w1", slug: "ada", role: "owner", kind: "personal" }, { workspaceId: "w2", slug: "crew", role: "editor", kind: "shared" }] };
const byName = (tools, name) => tools.find((entry) => entry.tool.name === name);

test("a 1:1 turn switches check-ins, quiet hours, pings, overnight and tidy in the person's own notes", async () => {
  const { files, dispatch } = notes({ "tex/heartbeat.md": "---\npaused: no\n---\nOnly deadlines." });
  const set = byName(settingsTools({ session, controlPlane: null, group: null, dispatch }), "tex_setting_set");
  assert.equal((await set.call({ setting: "checkins", value: "off" })).isError, undefined);
  assert.match(files.get("tex/heartbeat.md"), /paused: yes/);
  assert.match(files.get("tex/heartbeat.md"), /Only deadlines\./, "their own words stay");
  await set.call({ setting: "quiet_hours", value: "11 pm to 7 am" });
  assert.match(files.get("tex/heartbeat.md"), /quiet-hours: 11 pm to 7 am/);
  assert.equal((await set.call({ setting: "quiet_hours", value: "whenever" })).isError, true, "a window that reads as none changes nothing");
  await set.call({ setting: "pings", value: "relaxed" });
  assert.match(files.get("tex/attention.md"), /tolerance: relaxed/);
  await set.call({ setting: "overnight", value: "off" });
  assert.match(files.get("tex/dreams.md"), /paused: yes/);
  await set.call({ setting: "tidy", value: "off" });
  assert.match(files.get("tex/housekeeping.md"), /paused: yes/);
  assert.equal((await set.call({ setting: "vault", value: "on" })).isError, true);

  const snapshot = await settingsSnapshot({ session, controlPlane: null, group: null, dispatch });
  assert.match(snapshot, /Check-ins: off; quiet hours: 11 pm to 7 am\./);
  assert.match(snapshot, /Texts from their other AIs: relaxed\./);
  assert.match(snapshot, /Overnight About me rewrite: off\. Daily tidy of their notes: off\./);
  assert.match(snapshot, /Workspaces they can reach: @ada \(personal, this chat's default\), @crew \(editor\)\./);
  assert.match(snapshot, /Only in the app: .*Delete a saved login \(Context app → Settings → Vault\)/);
});

test("a group turn never gets the person's own switches", () => {
  const { dispatch } = notes();
  const tools = settingsTools({ session, controlPlane: { vaultText: async () => null }, group: { key: "k" }, dispatch });
  assert.equal(byName(tools, "tex_setting_set"), undefined);
  assert.ok(byName(tools, "vault_access"));
  assert.equal(settingsTools({ session, controlPlane: { vaultText: async () => null }, group: { key: "k", guestTagger: true }, dispatch }).length, 0, "a guest's tag gets neither");
});

function vaultPlane(answers) {
  const calls = [];
  return {
    calls,
    vaultText: async (token, workspaceId, request) => {
      calls.push({ token, workspaceId, ...request });
      return answers(workspaceId, request);
    },
  };
}

const gusto = { entry: "a".repeat(32), name: "Gusto", type: "login", sites: ["gusto.com"], savedBy: "You", yours: true, who: ["you (saved it)"], ais: [] };

test("sharing a login runs only on the person's own words, in the workspace it's saved in", async () => {
  const plane = vaultPlane((workspaceId, request) =>
    request.op === "list" ? { status: "done", entries: workspaceId === "w2" ? [gusto] : [] } : { status: "done", entry: { ...gusto, who: ["you (saved it)", "everyone in the workspace"] } },
  );
  const quiet = byName(settingsTools({ session, controlPlane: plane, group: null, dispatch: null, words: "what's the weather" }), "vault_access");
  assert.equal((await quiet.call({ do: "share", entry: gusto.entry, to: "workspace", context: "@crew" })).isError, true);
  assert.equal(plane.calls.length, 0, "nothing reached the control plane");

  const asked = byName(settingsTools({ session, controlPlane: plane, group: null, dispatch: null, words: "share my Gusto login with everyone in crew" }), "vault_access");
  const listed = await asked.call({ do: "list" });
  assert.match(listed.content[0].text, /In @crew:\n- Gusto \(login on gusto\.com, id a+\): you \(saved it\)/);
  assert.deepEqual(plane.calls.map((call) => call.workspaceId).sort(), ["w1", "w2"], "every workspace they edit is listed");
  const shared = await asked.call({ do: "share", entry: gusto.entry, to: "workspace", context: "@crew" });
  assert.match(shared.content[0].text, /Done\. Now, in @crew: - Gusto .*everyone in the workspace/);
  assert.deepEqual(plane.calls.at(-1), { token: "tok", workspaceId: "w2", op: "share", entry: gusto.entry, to: "workspace" });
  assert.equal((await asked.call({ do: "share", entry: gusto.entry, to: "workspace", context: "@nobody" })).isError, true, "a workspace they don't edit is refused here");
});

test("taking a login back needs no consent, and a refusal is said, never a success", async () => {
  const plane = vaultPlane(() => ({ status: "not_yours" }));
  const tool = byName(settingsTools({ session, controlPlane: plane, group: null, dispatch: null, words: "" }), "vault_access");
  const answer = await tool.call({ do: "only_me", entry: gusto.entry });
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /Only the person who saved that login/);
  assert.equal(plane.calls[0].op, "only_me");
});

test("the judge decides a widening when the deployment has one", async () => {
  const plane = vaultPlane(() => ({ status: "done", entry: gusto }));
  const no = byName(settingsTools({ session, controlPlane: plane, group: null, dispatch: null, words: "share the login", judge: async () => ({ allow: false }) }), "vault_access");
  assert.equal((await no.call({ do: "share", entry: gusto.entry, to: "@sam" })).isError, true);
  const yes = byName(settingsTools({ session, controlPlane: plane, group: null, dispatch: null, words: "share the login with @sam", judge: async () => ({ allow: true }) }), "vault_access");
  assert.equal((await yes.call({ do: "share", entry: gusto.entry, to: "@sam" })).isError, undefined);
});

test("send tex_settings reads the instructions and every other setting together", async () => {
  const { dispatch } = notes();
  const tools = commandTools({ run: async () => ({ status: "done", instructions: "no emoji", sharing: true }), group: null, snapshot: () => settingsSnapshot({ session, controlPlane: null, group: null, dispatch }) });
  const answer = await byName(tools, "tex_settings_get").call({});
  assert.match(answer.content[0].text, /Instructions: "no emoji"\. Sharing their finished chats with the Context team: on\./);
  assert.match(answer.content[0].text, /Check-ins: on; quiet hours: none\./);
});
