/**
 * The data sync object: one SQLite-backed Durable Object per workspace, named `data:<workspaceId>`, that keeps that
 * workspace's "Fetch from a URL" sources up to date every hour (`docs/decisions/data-and-metrics.md`, "The sync
 * object"). Its own object, never the workspace object's alarm, so a slow or failing address never delays a note
 * save, the mirror flush or a Tex routine.
 *
 * What it keeps, and nothing else: the workspace it belongs to (pinned by the first call; any other is refused), per
 * armed source its `about.md` note id, who armed it and when, and the last run's time and outcome, and per connected
 * app (Cloudflare) its read-only key, sealed to this workspace and that app (`connect/seal.js`), with who
 * connected it and when. Never a fetched value, never a note's words, and never a key in the clear: it opens one
 * only for that app's run, and no op answers one back.
 *
 * Each armed entry is a source (`kind: "url"`, by its `about.md`) or a right-now metric (`kind: "metric"`, by its
 * note), whose hourly reading `snap.js` keeps in its own sheet beside the note.
 *
 * - **Arm** (`op: "arm"`, only through the gateway's `POST /data/sync`, which has checked the caller may edit):
 *   records the source and runs it at once, so the person learns straight away whether the address is refused. A
 *   source run under a minute ago is not run again: arming many times never hammers an address. One alarm at most;
 *   arming again never stacks one.
 * - **The alarm**, hourly: runs every armed source one after another (`run.js`), each asking again whether its
 *   person, its `about.md` and its address are still good. A source that stops is dropped and its last word kept
 *   for its page; the alarm is set again only while a source is left to run.
 * - **Status** (`op: "status"`): the last run of each source asked, by note id, for a reader the gateway has
 *   already judged able to read that source's `about.md`.
 * - **Connect** (`op: "connect"`, only through the gateway's route, which has checked the caller is an owner): checks
 *   the pasted key with the app itself (`connect/apps.js`), seals it, keeps it in place of any earlier one, and arms
 *   the app's source by its `about.md`, run at once. A key the app refuses is not kept.
 * - **Disconnect** (`op: "disconnect"`, owners too): forgets the app's key and stops its sources.
 *
 * Self-hosting on the free tier: leave the `DATA_SYNC` binding out, and `POST /data/sync` answers 501.
 */

import { objectByName } from "../../objectPlace.js";
import { workspaceClient } from "../../workspaceStore/api.js";
import { runUrlSource } from "./run.js";
import { runAppSource } from "./runApp.js";
import { runMetricSnap } from "./snap.js";
import { APPS, appNamed } from "../connect/apps.js";
import { sealConnection } from "../connect/seal.js";

/** How often each source runs. */
export const SYNC_EVERY_MS = 60 * 60 * 1000;
/** Arming a source run this recently answers its last run instead of fetching again. */
export const RERUN_AFTER_MS = 60 * 1000;
/** The most sources one workspace may arm, and the most right-now metrics it may keep: an hour's runs stay inside one alarm. */
export const MAX_SOURCES = 25;
/** What an armed entry is: a Fetch from a URL source or an app's (by its about.md), or a right-now metric (by its note). */
const KINDS = new Set(["url", "metric", "app"]);
const kindOf = (entry) => (entry?.kind === "metric" ? "metric" : entry?.kind === "app" ? "app" : "url");
/** The longest key one app takes, as pasted. */
const MAX_KEY = 512;
/** How long a stopped source's last word is kept for its page. */
const STOPPED_KEPT_MS = 30 * 24 * SYNC_EVERY_MS;

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_ID = /^[A-Za-z0-9_|:.-]{1,128}$/;

/** The one object name per workspace. Exported so a test can pin that two workspaces never share one. */
export function dataObjectName(workspaceId) {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) throw new TypeError("a data sync object belongs to one workspace");
  return `data:${workspaceId}`;
}

/** The workspace's sync object, or `null` where this deployment has no `DATA_SYNC` binding. */
export function dataSyncStub(env, workspaceId) {
  const namespace = env?.DATA_SYNC;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, dataObjectName(workspaceId));
}

/** One call to a workspace's sync object: `{status, body}`. */
export async function callDataSync(stub, op, fields) {
  const response = await stub.fetch("https://data-sync.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fields, op }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const answer = (body, status = 200) => Response.json(body, { status });

/** A source's last run as its page reads it: never anything but a time, an outcome, a count and a sentence. */
function lastOf(source) {
  if (!source?.last) return null;
  const { at, outcome, said, rows } = source.last;
  return { at, outcome, ...(typeof said === "string" ? { said } : {}), ...(Number.isFinite(rows) ? { rows } : {}) };
}

/**
 * The class, with what a run reaches injected so the suite can drive it offline: `fetcher` and `resolve` (the
 * address and its DNS), `openStore` (the bucket from an opened binding) and `now`.
 */
export function dataSyncClass(deps = {}) {
  return class DataSync {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.storage = state.storage;
      /** Runs one at a time: an arm's run and the alarm's never write one sheet at once. */
      this.tail = Promise.resolve();
    }

    now() {
      return typeof deps.now === "function" ? deps.now() : Date.now();
    }

    async held() {
      return {
        workspaceId: (await this.storage.get("workspace")) ?? null,
        sources: (await this.storage.get("sources")) ?? {},
      };
    }

    /** Pins the first workspace this object is asked about; any other is refused, so two never share one. */
    async pin(workspaceId) {
      if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return false;
      const pinned = (await this.storage.get("workspace")) ?? null;
      if (pinned === null) {
        await this.storage.put("workspace", workspaceId);
        return true;
      }
      return pinned === workspaceId;
    }

    serially(work) {
      const run = this.tail.then(work, work);
      this.tail = run.catch(() => {});
      return run;
    }

    async fetch(request) {
      let fields;
      try {
        fields = await request.json();
      } catch {
        return answer({ error: "bad_call" }, 400);
      }
      if (!fields || typeof fields !== "object") return answer({ error: "bad_call" }, 400);
      if (!(await this.pin(fields.workspaceId))) return answer({ error: "wrong_workspace" }, 403);
      if (fields.op === "arm") return answer(await this.serially(() => this.arm(fields)));
      if (fields.op === "status") return answer(await this.status(fields));
      if (fields.op === "connect") return answer(await this.serially(() => this.connect(fields)));
      if (fields.op === "disconnect") return answer(await this.serially(() => this.disconnect(fields)));
      return answer({ error: "bad_call" }, 400);
    }

    async arm({ workspaceId, noteId, armedBy, kind = "url" }) {
      // An app's source is armed only by an owner's Connect, which brings its key.
      if (kind === "app") return { error: "bad_call" };
      if (typeof noteId !== "string" || !NOTE_ID.test(noteId) || typeof armedBy !== "string" || !USER_ID.test(armedBy) || !KINDS.has(kind)) return { error: "bad_call" };
      const { sources } = await this.held();
      const now = this.now();
      const old = sources[noteId] ?? null;
      // One note is one thing: an about.md is never armed as a metric, nor a metric's note as a source.
      if (old !== null && old.stopped !== true && kindOf(old) !== kind) return { error: "bad_call" };
      const live = Object.values(sources).filter((source) => source.stopped !== true && kindOf(source) === kind).length;
      if ((old === null || old.stopped === true) && live >= MAX_SOURCES) {
        return { error: "too_many", said: kind === "metric" ? `A workspace keeps at most ${MAX_SOURCES} right-now metrics.` : `A workspace syncs at most ${MAX_SOURCES} addresses.` };
      }
      const source = { noteId, armedBy, armedAt: now, last: old?.last ?? null, ...(kind === "metric" ? { kind } : {}) };
      // Run now unless it ran under a minute ago and was not stopped: arming again never hammers an address.
      const recent = old !== null && old.stopped !== true && old.last && now - old.last.at < RERUN_AFTER_MS;
      if (!recent) {
        const { gone: _gone, ...outcome } = await this.runOne(workspaceId, source, now);
        source.last = { at: now, ...outcome };
        if (outcome.outcome === "stopped") source.stopped = true;
      }
      sources[noteId] = source;
      await this.storage.put("sources", sources);
      await this.ensureAlarm(sources);
      return { armed: source.stopped !== true, last: lastOf(source) };
    }

    /**
     * An owner's Connect: the key checked with the app, sealed, kept, and the app's source armed and run. The key is
     * never answered back, logged or kept in the clear; a refused one is not kept at all.
     */
    async connect({ workspaceId, noteId, armedBy, app: named, key, account }) {
      const app = appNamed(named);
      if (app === null || typeof noteId !== "string" || !NOTE_ID.test(noteId) || typeof armedBy !== "string" || !USER_ID.test(armedBy)) return { error: "bad_call" };
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY || (account !== undefined && (typeof account !== "string" || account.length > 64))) return { error: "bad_call" };
      const { sources } = await this.held();
      const old = sources[noteId] ?? null;
      if (old !== null && old.stopped !== true && (kindOf(old) !== "app" || old.app !== app)) return { error: "bad_call" };
      const live = Object.values(sources).filter((source) => source.stopped !== true && kindOf(source) === "app").length;
      if ((old === null || old.stopped === true) && live >= MAX_SOURCES) return { error: "too_many", said: `A workspace connects at most ${MAX_SOURCES} app sources.` };
      const checked = await APPS[app].check({ key, ...(account ? { account } : {}) }, deps.fetcher ?? fetch);
      if (!checked.ok) return { error: "refused", said: `${checked.said}.` };
      let sealed;
      try {
        sealed = await sealConnection(checked.kept, { secret: this.env?.GATEWAY_SECRET, workspaceId, app });
      } catch {
        return { error: "unavailable", said: "This deployment can't keep a key." };
      }
      const now = this.now();
      const connections = (await this.storage.get("connections")) ?? {};
      connections[app] = { sealed, by: armedBy, at: now };
      await this.storage.put("connections", connections);
      console.log(JSON.stringify({ event: "data_app_connected", workspaceId, app }));
      const source = { noteId, armedBy, armedAt: now, last: old?.last ?? null, kind: "app", app };
      const { gone: _gone, ...outcome } = await this.runOne(workspaceId, source, now);
      source.last = { at: now, ...outcome };
      if (outcome.outcome === "stopped") source.stopped = true;
      sources[noteId] = source;
      await this.storage.put("sources", sources);
      await this.ensureAlarm(sources);
      return { armed: source.stopped !== true, last: lastOf(source) };
    }

    /** An owner's Disconnect: the app's key forgotten, and every source of that app stopped. */
    async disconnect({ workspaceId, app: named }) {
      const app = appNamed(named);
      if (app === null) return { error: "bad_call" };
      const connections = (await this.storage.get("connections")) ?? {};
      const had = Object.hasOwn(connections, app);
      delete connections[app];
      await this.storage.put("connections", connections);
      const { sources } = await this.held();
      const now = this.now();
      for (const source of Object.values(sources)) {
        if (kindOf(source) !== "app" || source.app !== app || source.stopped === true) continue;
        source.stopped = true;
        source.last = { at: now, outcome: "stopped", said: `Stopped: ${APPS[app].name} was disconnected. An owner can connect it again here.` };
      }
      await this.storage.put("sources", sources);
      await this.ensureAlarm(sources);
      if (had) console.log(JSON.stringify({ event: "data_app_disconnected", workspaceId, app }));
      return { disconnected: had };
    }

    async status({ noteIds }) {
      if (!Array.isArray(noteIds) || noteIds.length === 0 || noteIds.length > 50 || noteIds.some((id) => typeof id !== "string" || !NOTE_ID.test(id))) return { error: "bad_call" };
      const { sources } = await this.held();
      return {
        sources: noteIds.map((noteId) => {
          const source = sources[noteId] ?? null;
          return { noteId, armed: source !== null && source.stopped !== true, last: lastOf(source) };
        }),
      };
    }

    /** One source's run, never throwing: anything unexpected is a failed run, tried again next hour. */
    async runOne(workspaceId, source, now) {
      const client = workspaceClient(this.env, workspaceId);
      if (client === null) return { outcome: "failed", said: "This deployment has no workspace objects." };
      try {
        const kind = kindOf(source);
        const run = kind === "metric" ? runMetricSnap : kind === "app" ? runAppSource : runUrlSource;
        // An app's run alone is handed its sealed key, and only its own app's.
        const sealed = kind === "app" ? ((await this.storage.get("connections")) ?? {})[source.app]?.sealed ?? null : undefined;
        const done = await run({ ...deps, env: this.env, client, workspaceId, source, now: () => now, ...(kind === "app" ? { sealed } : {}) });
        const { outcome, said, rows } = done;
        console.log(JSON.stringify({ event: "data_sync_run", workspaceId, kind: kindOf(source), outcome, ...(Number.isFinite(rows) ? { rows } : {}) }));
        return { outcome, ...(typeof said === "string" ? { said } : {}), ...(Number.isFinite(rows) ? { rows } : {}), ...(done.gone === true ? { gone: true } : {}) };
      } catch (error) {
        console.error(JSON.stringify({ event: "data_sync_run_failed", workspaceId, error: String(error?.name ?? "Error").slice(0, 60) }));
        return { outcome: "failed", said: "The sync failed; it will try again within the hour." };
      }
    }

    /** The alarm stays at most one: set when a source is left to run and none is set, cleared when none is left. */
    async ensureAlarm(sources) {
      const running = Object.values(sources).some((source) => source.stopped !== true);
      const set = await this.storage.getAlarm();
      if (!running) {
        if (set !== null) await this.storage.deleteAlarm();
        return;
      }
      if (set === null) await this.storage.setAlarm(this.now() + SYNC_EVERY_MS);
    }

    async alarm() {
      await this.serially(async () => {
        const { workspaceId, sources } = await this.held();
        if (workspaceId === null) return;
        const now = this.now();
        for (const noteId of Object.keys(sources)) {
          const source = sources[noteId];
          if (source.stopped === true) {
            // A stopped source's last word is kept a while for its page, then forgotten.
            if (!source.last || now - source.last.at > STOPPED_KEPT_MS) delete sources[noteId];
            continue;
          }
          const { gone, ...outcome } = await this.runOne(workspaceId, source, now);
          source.last = { at: now, ...outcome };
          if (outcome.outcome === "stopped") source.stopped = true;
          // Its about.md is gone: nobody can ask its page about it again, so nothing is kept.
          if (gone === true) delete sources[noteId];
          await this.storage.put("sources", sources);
        }
        await this.storage.put("sources", sources);
        // The alarm that called this has fired: set the next one only while a source is left to run.
        const running = Object.values(sources).some((source) => source.stopped !== true);
        if (running) await this.storage.setAlarm(this.now() + SYNC_EVERY_MS);
        else if ((await this.storage.getAlarm()) !== null) await this.storage.deleteAlarm();
      });
    }
  };
}

/** The class this Worker exports (`src/index.js`). */
export const DataSyncObject = dataSyncClass();
