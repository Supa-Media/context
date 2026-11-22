/**
 * THE STANDING BENCH OBJECT (Dev2, 2026-11-22: "why can't we just have a benchmark object that contains the notes").
 *
 * One copy of one bench workspace: the gateway's own `WorkspaceStore`, so a search ranks through exactly the code a
 * real workspace object runs, in a namespace of its own (`BENCH_STORE`) with an environment of its own
 * (`benchEnvOf`): no control plane, no real workspace, no texting, a gateway secret of its own. It holds public
 * benchmark notes only, which is what lets any caller the bench route admits read them.
 *
 * A search waits its turn in one object, so a run asks many copies of the same notes at once (`route.js`). The
 * first copy is loaded by the caller; every other copy pulls the notes from it, on its own alarm, and builds its own
 * indexes, its embeddings read from the bench's vector cache (`env.js` `cachedAi`), so the model embeds a note once.
 *
 * Its calls (`/bench/*`) come from the bench route only: the gateway never routes a person's call here.
 */

import { WorkspaceStore } from "../../../../apps/mcp/src/workspaceStore.js";
import { MAX_ROWS_PER_PUT } from "../../../../apps/mcp/src/workspaceStore/api.js";
import { sealBinding } from "../../../../apps/mcp/src/workspaceStore/bindingSeal.js";
import { benchEnvOf, serveVectors, serveWorlds, VECTORS_PATH, WORLDS_PATH } from "./env.js";
import { benchBindingAnswer, noteIdOf, rowsOf } from "./world.js";

/** Notes one clone pass pulls from the first copy. */
export const CLONE_PAGE = 200;
/** How long one alarm keeps building before it hands the object back to its calls. */
const ALARM_BUDGET_MS = 10_000;
/** Most notes one load call or one notes page carries. */
export const MAX_NOTES_PER_CALL = 500;

const json = (value, status = 200) => Response.json(value, { status });

const put = (key, body) => new Request("https://tex-store.internal/put", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key, options: {} })) }, body });

export class BenchStore extends WorkspaceStore {
  constructor(state, env) {
    super(state, benchEnvOf(env));
  }

  /** The bench's own facts about this copy: its workspace, how many notes it wants, where it clones from. */
  meta() {
    const sql = this.state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bench_meta (name TEXT PRIMARY KEY, value TEXT)");
    const rows = [...sql.exec("SELECT name, value FROM bench_meta").toArray()];
    return Object.fromEntries(rows.map((row) => [row.name, JSON.parse(row.value)]));
  }

  setMeta(name, value) {
    const sql = this.state.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bench_meta (name TEXT PRIMARY KEY, value TEXT)");
    sql.exec("INSERT INTO bench_meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, JSON.stringify(value));
  }

  ready() {
    const fresh = this.store === null;
    const store = super.ready();
    // Nothing here is mirrored to a control plane: the outbox is emptied, never sent.
    if (fresh) {
      store.flushMirror = async () => {
        const pending = store.mirror.pending(1_000);
        if (pending.length) store.mirror.drop(pending.map((row) => row.seq));
        return { done: true };
      };
    }
    return store;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === VECTORS_PATH) return await serveVectors(this.state.storage.sql, request);
    if (path === WORLDS_PATH) return await serveWorlds(this.state.storage.sql, request);
    if (!path.startsWith("/bench/")) return await super.fetch(request);
    const input = await request.json().catch(() => ({}));
    const store = this.ready();
    if (path === "/bench/setup") return json(await this.setUp(input));
    if (path === "/bench/notes") return json(this.notesPage(input));
    if (path === "/bench/status") return json(this.status());
    if (path === "/bench/clone") {
      this.setMeta("cloneFrom", { workspaceId: String(input.from), after: "", page: Math.max(1, Math.min(Number(input.page) || CLONE_PAGE, CLONE_PAGE)) });
      await this.state.storage.setAlarm(Date.now());
      return json(this.status());
    }
    if (path === "/bench/build") {
      // Build now, for at most `ms`, and arm the alarm to go on: a caller that loads waits on the first build.
      await this.buildFor(Math.min(Number(input.ms) || 0, 20_000));
      await this.rearm();
      return json(this.status());
    }
    if (path === "/bench/drop") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return json({ dropped: true });
    }
    void store;
    return json({ error: "unknown bench call" }, 404);
  }

  /**
   * One copy's workspace set up as `objectWorld.mjs` sets a bench workspace up: its rows, rules, members and sealed
   * binding, read from the object (home `object`). `files` are paths; each note's id comes from its path.
   */
  async setUp({ workspaceId, name, kind, files, rules, members }) {
    const store = this.ready();
    const ids = new Map();
    for (const path of files) ids.set(path, await noteIdOf(name, path));
    store.rows.pinWorkspace(workspaceId);
    const rows = rowsOf(files, ids);
    for (let at = 0; at < rows.length; at += MAX_ROWS_PER_PUT) store.rows.put(rows.slice(at, at + MAX_ROWS_PER_PUT));
    store.rows.putRules(rules);
    store.members.put("members", members);
    store.members.setHome("object");
    const answer = benchBindingAnswer({ workspaceId, name, kind, rules });
    store.binding.put({ sealed: await sealBinding(answer, { secret: this.env.GATEWAY_SECRET, workspaceId }), at: Date.now(), epoch: store.binding.get().epoch });
    this.setMeta("workspace", { workspaceId, name, files: files.length });
    return { ids: Object.fromEntries(ids) };
  }

  /** A page of this copy's notes, by key, for another copy to pull. */
  notesPage({ after = "", limit = CLONE_PAGE }) {
    const store = this.ready();
    const listed = store.objects.list({ prefix: "notes/", startAfter: String(after || "") || undefined, limit: Math.min(Number(limit) || CLONE_PAGE, MAX_NOTES_PER_CALL) });
    const keys = (listed.objects ?? []).map((object) => object.key);
    const notes = keys.map((key) => ({ key, text: new TextDecoder().decode(store.objects.get(key).body) }));
    return { notes, next: listed.truncated ? keys.at(-1) : null };
  }

  status() {
    const store = this.ready();
    const meta = this.meta();
    const notes = Number(this.state.storage.sql.exec("SELECT COUNT(*) AS n FROM objects WHERE key LIKE 'notes/%'").toArray()[0]?.n ?? 0);
    let words = null;
    try {
      words = store.search.catchUp({ rows: 0, bytes: 0 });
    } catch {
      words = null;
    }
    let meaning = null;
    try {
      meaning = store.meaning.state();
    } catch {
      meaning = null;
    }
    const want = meta.workspace?.files ?? null;
    const ready = want !== null && notes >= want && words === 0 && meaning !== null && meaning.waiting === 0 && meaning.complete === true;
    return { set: meta.workspace !== undefined, notes, want, cloning: meta.cloneFrom !== undefined, wordsWaiting: words, meaningWaiting: meaning?.waiting ?? null, ready };
  }

  /** One clone page: the next notes from the first copy, put here as a real save puts them. */
  async clonePass() {
    const from = this.meta().cloneFrom;
    if (!from) return false;
    const source = this.env.WORKSPACE_STORE.get(this.env.WORKSPACE_STORE.idFromName(`workspace:${from.workspaceId}`));
    const page = await (await source.fetch(new Request("https://bench.internal/bench/notes", { method: "POST", body: JSON.stringify({ after: from.after, limit: from.page ?? CLONE_PAGE }) }))).json();
    for (const note of page.notes ?? []) {
      const response = await super.fetch(put(note.key, note.text));
      if (response.status !== 200) throw new Error(`a cloned note was refused (${response.status})`);
    }
    if (page.next) this.setMeta("cloneFrom", { ...from, after: page.next });
    else this.state.storage.sql.exec("DELETE FROM bench_meta WHERE name = 'cloneFrom'");
    return true;
  }

  /** Both indexes built for at most `ms`. */
  async buildFor(ms) {
    const store = this.ready();
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const words = store.search.catchUp();
      const meaning = await store.meaning.catchUp();
      // Another build of this object's meaning index is running (an alarm beside a build call): it goes on, not this.
      if (meaning?.busy) return;
      const waiting = (Number(words) || 0) + (Number(meaning?.waiting) || 0);
      if (waiting === 0) return;
    }
  }

  async rearm() {
    const status = this.status();
    if (status.cloning || (status.set && !status.ready)) await this.state.storage.setAlarm(Date.now() + 50);
    else await this.state.storage.deleteAlarm();
  }

  /** The alarm clones, then builds, and goes on until the copy is ready. Nothing of a workspace's Tex runs here. */
  async runAlarm() {
    const until = Date.now() + ALARM_BUDGET_MS;
    while (Date.now() < until && (await this.clonePass())) {
      // Clone pages until the budget is spent.
    }
    if (Date.now() < until && !this.meta().cloneFrom) await this.buildFor(until - Date.now());
    await this.rearm();
  }
}
