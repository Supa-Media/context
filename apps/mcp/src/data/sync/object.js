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
 * - **Two locks.** The state lock (`serially`) covers the short reads and writes of the stored keys. The run lock
 *   (`oneRun`) covers one source's run, so two runs never write one sheet at once. A run holds only the run lock, and
 *   the alarm re-reads the sources before it writes each result, so a disconnect or re-arm that lands during a run is
 *   kept, not overwritten; reads and disconnects answer while a run is in flight.
 * - **Background runs.** A run an owner's Connect or a repository pick asks for is not run inside that answer: its
 *   note id joins `soon`, and an alarm is set to now. Once it has run, the alarm goes back to the hourly time that was
 *   set aside in `hourly`.
 * - **Status** (`op: "status"`): the last run of each source asked, by note id, for a reader the gateway has
 *   already judged able to read that source's `about.md`.
 * - **Connect** (`op: "connect"`, only through the gateway's route, which has checked the caller is an owner): checks
 *   the pasted key with the app itself (`connect/apps.js`), seals it, keeps it in place of any earlier one, and arms
 *   the app's source by its `about.md`, run at once. A key the app refuses is not kept. An installed app (GitHub) is
 *   connected with GitHub's one-time code instead: its connect answers at once and its first run is a background run.
 * - **Repositories** (`op: "repos"`): GitHub's list is read without the state lock, so it answers while a run is in
 *   flight. A pick is stored and its source queued as a background run.
 * - **Disconnect** (`op: "disconnect"`, owners too): forgets the app's key and stops its sources.
 *
 * Self-hosting on the free tier: leave the `DATA_SYNC` binding out, and `POST /data/sync` answers 501.
 */

import { objectByName } from "../../objectPlace.js";
import { workspaceClient } from "../../workspaceStore/api.js";
import { runUrlSource } from "./run.js";
import { runAppSource } from "./runApp.js";
import { runMetricSnap } from "./snap.js";
import { runUsageSource } from "./runUsage.js";
import { APPS, appNamed } from "../connect/apps.js";
import { openConnection, sealConnection } from "../connect/seal.js";
import { listGithubRepos } from "../connect/githubApp.js";
import { MAX_REPOS } from "../connect/github.js";

/** How often each source runs. */
export const SYNC_EVERY_MS = 60 * 60 * 1000;
/** Arming a source run this recently answers its last run instead of fetching again. */
export const RERUN_AFTER_MS = 60 * 1000;
/** The most sources one workspace may arm, and the most right-now metrics it may keep: an hour's runs stay inside one alarm. */
export const MAX_SOURCES = 25;
/** What an armed entry is: a Fetch from a URL source or an app's (by its about.md), or a right-now metric (by its note). */
const KINDS = new Set(["url", "metric", "app", "usage"]);
const kindOf = (entry) => (entry?.kind === "metric" ? "metric" : entry?.kind === "app" ? "app" : entry?.kind === "usage" ? "usage" : "url");
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
      /** The state lock's chain: short reads and writes of the stored keys, one at a time. */
      this.tail = Promise.resolve();
      /** The run lock's chain: one source's run at a time, so two runs never write one sheet at once. */
      this.runTail = Promise.resolve();
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

    /** The run lock. Code holding it never waits for the state lock, so the two cannot deadlock. */
    oneRun(work) {
      const run = this.runTail.then(work, work);
      this.runTail = run.catch(() => {});
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
      // A list (no `set`) reads only the connection and GitHub, so it never waits behind a state change or a run.
      if (fields.op === "repos") return answer(fields.set === undefined ? await this.repos(fields) : await this.serially(() => this.repos(fields)));
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
      const source = { noteId, armedBy, armedAt: now, last: old?.last ?? null, ...(kind === "metric" || kind === "usage" ? { kind } : {}) };
      // Run now unless it ran under a minute ago and was not stopped: arming again never hammers an address.
      const recent = old !== null && old.stopped !== true && old.last && now - old.last.at < RERUN_AFTER_MS;
      if (!recent) {
        const { gone: _gone, ...outcome } = await this.oneRun(() => this.runOne(workspaceId, source, now));
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
    async connect({ workspaceId, noteId, armedBy, app: named, key, account, installation }) {
      const app = appNamed(named);
      if (app === null || typeof noteId !== "string" || !NOTE_ID.test(noteId) || typeof armedBy !== "string" || !USER_ID.test(armedBy)) return { error: "bad_call" };
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY || (account !== undefined && (typeof account !== "string" || account.length > 64))) return { error: "bad_call" };
      // An installed app (GitHub) is connected with GitHub's one-time code and the installation it names, never a key.
      const installed = APPS[app].installed === true;
      if (installed !== (typeof installation === "string" && /^[0-9]{1,15}$/.test(installation))) return { error: "bad_call" };
      const { sources } = await this.held();
      const old = sources[noteId] ?? null;
      if (old !== null && old.stopped !== true && (kindOf(old) !== "app" || old.app !== app)) return { error: "bad_call" };
      const live = Object.values(sources).filter((source) => source.stopped !== true && kindOf(source) === "app").length;
      if ((old === null || old.stopped === true) && live >= MAX_SOURCES) return { error: "too_many", said: `A workspace connects at most ${MAX_SOURCES} app sources.` };
      const input = installed ? { code: key, installation } : { key, ...(account ? { account } : {}) };
      const checked = await APPS[app].check(input, deps.fetcher ?? fetch, this.env, this.now());
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
      if (installed) {
        // GitHub's first run is not waited for: the alarm runs it, so this answers at once. A stopped source's last word
        // is not carried over, so the page never reads "stopped" for a source that is starting again.
        const source = { noteId, armedBy, armedAt: now, last: old !== null && old.stopped !== true ? (old.last ?? null) : null, kind: "app", app };
        const current = (await this.storage.get("sources")) ?? {};
        current[noteId] = source;
        await this.storage.put("sources", current);
        await this.ensureAlarm(current);
        await this.runSoon(noteId);
        return { armed: true, last: lastOf(source) };
      }
      const source = { noteId, armedBy, armedAt: now, last: old?.last ?? null, kind: "app", app };
      const { gone: _gone, ...outcome } = await this.oneRun(() => this.runOne(workspaceId, source, now));
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

    /**
     * An owner's GitHub repositories: every one the installation was given, and which the source reads. With `set`, the
     * owner's pick (each one the installation has), sealed in place of the last, and each live source queued for a
     * background run (`runSoon`), never run inside this answer.
     */
    async repos({ workspaceId, set }) {
      const app = "github";
      if (set !== undefined && (!Array.isArray(set) || set.length === 0 || set.length > MAX_REPOS || set.some((name) => typeof name !== "string" || name.length > 201))) return { error: "bad_call" };
      const connections = (await this.storage.get("connections")) ?? {};
      const held = connections[app] ?? null;
      if (held === null) return { error: "not_connected", said: "GitHub isn't connected." };
      let kept;
      try {
        kept = await openConnection(held.sealed, { secret: this.env?.GATEWAY_SECRET, workspaceId, app });
      } catch {
        return { error: "not_connected", said: "GitHub's connection can't be opened any more; connect it again." };
      }
      const listed = await listGithubRepos({ kept, env: this.env, fetcher: deps.fetcher ?? fetch, now: this.now() });
      if (!listed.ok) return { error: listed.refused ? "not_connected" : "unavailable", said: `${listed.said}.` };
      const names = new Set(listed.repos.map((repo) => repo.name));
      if (set === undefined) return { repos: listed.repos, picked: Array.isArray(kept.repos) ? kept.repos.filter((name) => names.has(name)) : null };
      const picked = [...new Set(set)];
      if (picked.some((name) => !names.has(name))) return { error: "bad_call", said: "That repository isn't one this installation can read." };
      connections[app] = { ...held, sealed: await sealConnection({ ...kept, repos: picked }, { secret: this.env?.GATEWAY_SECRET, workspaceId, app }) };
      await this.storage.put("connections", connections);
      const { sources } = await this.held();
      for (const [noteId, source] of Object.entries(sources)) {
        if (kindOf(source) !== "app" || source.app !== app || source.stopped === true) continue;
        await this.runSoon(noteId);
      }
      return { repos: listed.repos, picked };
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
        const run = kind === "metric" ? runMetricSnap : kind === "app" ? runAppSource : kind === "usage" ? runUsageSource : runUrlSource;
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

    /**
     * Asks for one source's run in the background (call it only under the state lock). The note id joins `soon`, and
     * the alarm is set to now. An alarm rather than unawaited work: an alarm is durable (it survives eviction and a
     * restart, and the runtime retries it), while work left running after the object answers can be cut off. It keeps
     * one alarm, so the hourly time it displaces is kept in `hourly` until the run-soon alarm has run.
     */
    async runSoon(noteId) {
      const now = this.now();
      const soon = new Set((await this.storage.get("soon")) ?? []);
      soon.add(noteId);
      await this.storage.put("soon", [...soon]);
      if ((await this.storage.get("hourly")) === undefined) {
        const set = await this.storage.getAlarm();
        await this.storage.put("hourly", set !== null && set > now ? set : now + SYNC_EVERY_MS);
      }
      await this.storage.setAlarm(now);
    }

    /**
     * The alarm stays at most one: set when a source is left to run and none is set, cleared when none is left (and
     * then the background queue and its displaced hourly time are forgotten too).
     */
    async ensureAlarm(sources) {
      const running = Object.values(sources).some((source) => source.stopped !== true);
      const set = await this.storage.getAlarm();
      if (!running) {
        if (set !== null) await this.storage.deleteAlarm();
        await this.storage.delete("soon");
        await this.storage.delete("hourly");
        return;
      }
      if (set === null) await this.storage.setAlarm(this.now() + SYNC_EVERY_MS);
    }

    /**
     * The alarm, which takes the state lock and the run lock one after the other, never nested. It claims what it runs
     * under the state lock, runs each source under the run lock alone, and before it writes a result it reads the
     * sources again: a source disconnected, stopped or re-armed as something else meanwhile keeps what landed.
     */
    async alarm() {
      const workspaceId = (await this.storage.get("workspace")) ?? null;
      if (workspaceId === null) return;
      const now = this.now();
      const { early, todo } = await this.serially(async () => {
        const hourly = (await this.storage.get("hourly")) ?? null;
        // A run-soon alarm comes before the hourly time it displaced: it runs only the sources waiting for one.
        const early = hourly !== null && now < hourly;
        const soon = (await this.storage.get("soon")) ?? [];
        const sources = (await this.storage.get("sources")) ?? {};
        if (!early) {
          for (const noteId of Object.keys(sources)) {
            // A stopped source's last word is kept a while for its page, then forgotten.
            const source = sources[noteId];
            if (source.stopped === true && (!source.last || now - source.last.at > STOPPED_KEPT_MS)) delete sources[noteId];
          }
          await this.storage.put("sources", sources);
          await this.storage.delete("hourly");
        }
        await this.storage.delete("soon");
        return { early, todo: early ? soon : Object.keys(sources) };
      });
      for (const noteId of todo) {
        const source = ((await this.storage.get("sources")) ?? {})[noteId];
        if (!source || source.stopped === true) continue;
        const { gone, ...outcome } = await this.oneRun(() => this.runOne(workspaceId, source, now));
        await this.serially(async () => {
          const sources = (await this.storage.get("sources")) ?? {};
          const fresh = sources[noteId];
          // Changed while it ran (disconnected, stopped, re-armed as something else): keep what landed, not this run.
          if (!fresh || fresh.stopped === true || kindOf(fresh) !== kindOf(source)) return;
          // Its about.md is gone: nobody can ask its page about it again, so nothing is kept.
          if (gone === true) delete sources[noteId];
          else sources[noteId] = { ...fresh, last: { at: now, ...outcome }, ...(outcome.outcome === "stopped" ? { stopped: true } : {}) };
          await this.storage.put("sources", sources);
        });
      }
      // Set the next alarm from what is stored now, which may have changed while the runs ran.
      await this.serially(async () => {
        const sources = (await this.storage.get("sources")) ?? {};
        const running = Object.values(sources).some((source) => source.stopped !== true);
        const soon = (await this.storage.get("soon")) ?? [];
        const hourly = (await this.storage.get("hourly")) ?? null;
        if (!running) {
          if ((await this.storage.getAlarm()) !== null) await this.storage.deleteAlarm();
          await this.storage.delete("soon");
          await this.storage.delete("hourly");
          return;
        }
        // A connect or pick landed during this run: its run-soon alarm comes now.
        if (soon.length > 0) await this.storage.setAlarm(this.now());
        // Otherwise the hourly time a run-soon alarm displaced.
        else if (hourly !== null) {
          await this.storage.setAlarm(hourly);
          await this.storage.delete("hourly");
        } else await this.storage.setAlarm(this.now() + SYNC_EVERY_MS);
      });
    }
  };
}

/** The class this Worker exports (`src/index.js`). */
export const DataSyncObject = dataSyncClass();
