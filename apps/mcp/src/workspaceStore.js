/**
 * The Durable Object that holds one workspace's notes, tree rows and access
 * rules (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). The shape is
 * `workspaceStore/api.js`; the calls are `workspaceStore/serve.js`.
 *
 * Reached only from this gateway, which has already checked who is asking and
 * passes the grant's scope and row tokens; the object decides what those may
 * see with the same `canSee` the gateway runs.
 *
 * It also keeps the app's live file tree (`workspaceStore/treeSockets.js`): a
 * socket the gateway's `/tree` route opened, told again whenever a call here
 * changes a folder it watches.
 *
 * And the app's access screens (`workspaceStore/accessSockets.js`): members,
 * invitations, connected apps and "shared with me", on a socket the gateway's
 * `/presence/access` route opened.
 *
 * And a personal workspace's object is also its person's Tex
 * (`workspaceStore/texHost.js`): Tex's notes, ledger, page and routine alarms,
 * in tables of their own, answered to a call that names the person.
 */

import { workspaceMachines } from "./workspaceStore/machines.js";
import { machineSockets } from "./workspaceStore/machineSockets.js";
import { workspaceMarks } from "./workspaceStore/marks.js";
import { workspaceHandles } from "./workspaceStore/handleCache.js";
import { workspaceAccess } from "./workspaceStore/accessRows.js";
import { texObjects } from "./texStore/objects.js";
import { TexObjectRefused } from "./texStore/objects.js";
import { callTexStore } from "./texStore/wire.js";
import { workspaceStub } from "./workspaceStore/api.js";
import { workspaceMembers } from "./workspaceStore/members.js";
import { workspaceRows } from "./workspaceStore/rows.js";
import { bindingRows } from "./workspaceStore/bindingRows.js";
import { workspaceFacts } from "./workspaceStore/facts.js";
import { workspaceSearch } from "./workspaceStore/searchIndex.js";
import { workspaceMeaning } from "./workspaceStore/meaningIndex.js";
import { bindingEmbedder } from "./search/meaning/embed.js";
import { personRows } from "./workspaceStore/personRows.js";
import { tokenIndexClient } from "./workspaceStore/tokenIndex.js";
import { serveWorkspaceStore } from "./workspaceStore/serve.js";
import { flushReach } from "./workspaceStore/serveMembers.js";
import { treeSockets } from "./workspaceStore/treeSockets.js";
import { accessSockets } from "./workspaceStore/accessSockets.js";
import { watchMembers, watchPerson } from "./workspaceStore/accessWatch.js";
import { createControlPlane } from "./controlPlane/index.js";
import { isTexCall, texHost } from "./workspaceStore/texHost.js";
import { mirrorOutbox } from "./workspaceStore/mirrorOutbox.js";
import { flushMirror } from "./workspaceStore/mirrorFlush.js";
import { indexBuilder } from "./workspaceStore/indexBuild.js";

const CALL = "x-tex-call";
/** How long a person-object write that failed waits before it is sent again. */
const REACH_RETRY_MS = 30_000;
/** The build calls whose answer says whether an index still has changes waiting. */
const INDEX_BUILDS = new Set(["ws.search.build", "ws.meaning.build"]);

function opOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null"))?.op ?? null;
  } catch {
    return null;
  }
}

function closeQuietly(ws) {
  try {
    ws.close(1000, "closed");
  } catch {
    // Already closed.
  }
}

export class WorkspaceStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = null;
    this.tree = null;
    this.access = null;
    this.texSide = null;
  }

  /** The person's Tex kept here (`workspaceStore/texHost.js`), built on first use. */
  tex() {
    if (this.texSide === null) {
      const store = this.ready();
      // An owed member write waits its retry, whatever Tex arms the one alarm for.
      // So does an index build with changes still waiting (`workspaceStore/indexBuild.js`): the earlier of the two.
      const otherWake = () => {
        const times = [store.members.pending().length > 0 || store.mirror.count() > 0 ? Date.now() + REACH_RETRY_MS : null, store.indexBuild.wake()];
        const set = times.filter((at) => typeof at === "number");
        return set.length === 0 ? null : Math.min(...set);
      };
      this.texSide = texHost(this.state, this.env, { otherWake });
    }
    return this.texSide;
  }

  ready() {
    if (this.store !== null) return this.store;
    const sql = this.state.storage.sql;
    const objects = texObjects(sql);
    const rows = workspaceRows(sql);
    const log = (event, fields) => console.log(JSON.stringify({ event, ...fields }));
    const store = {
      objects,
      rows,
      // What its notes say about themselves: links and props, read from the text held here (`workspaceStore/facts.js`).
      facts: workspaceFacts(sql, objects),
      // A word index over that text, so a search is one call here (`workspaceStore/searchIndex.js`).
      search: workspaceSearch(sql, { rows, objects }),
      // Its own meaning index (`workspaceStore/meaningIndex.js`), built with the model this Worker is bound to.
      meaning: workspaceMeaning(sql, { rows, objects, embed: bindingEmbedder(this.env?.AI) }),
      // "A change is coming" (`workspaceStore/marks.js`): left by a writer before it changes the tree in Convex.
      marks: workspaceMarks(sql),
      // Who each note and folder is open to, and the rules rendered from it (`workspaceStore/accessRows.js`).
      access: workspaceAccess(sql),
      handles: workspaceHandles(sql),
      // The storage binding, sealed so this object cannot read it (`workspaceStore/bindingRows.js`).
      binding: bindingRows(sql),
      // A personal workspace's object is also its person's: reach, shares to them and their connections.
      person: personRows(sql),
      sql,
      // Every connection it keeps is findable from an old refresh token (`workspaceStore/tokenIndex.js`).
      indexRefresh: async (hash, personalWorkspaceId) => await tokenIndexClient(this.env, hash)?.set(personalWorkspaceId),
      members: workspaceMembers(sql),
      // A person's own object (`workspace:<personalWorkspaceId>`), told of a member change (`serveMembers.js`).
      reach: (personalWorkspaceId) => {
        const stub = workspaceStub(this.env, personalWorkspaceId);
        if (stub === null) return null;
        return {
          call: async (op, body) => {
            try {
              return await (await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify(body)))).json();
            } catch (error) {
              // A 422 is a write the person object will never keep: sending it again would be refused again.
              if (error instanceof TexObjectRefused) error.refused = true;
              throw error;
            }
          },
        };
      },
      retryLater: async () => {
        // The one alarm may be set later, for a routine of the person's Tex: the retry comes first.
        const set = await this.state.storage.getAlarm();
        const at = Date.now() + REACH_RETRY_MS;
        if (set === null || set > at) await this.state.storage.setAlarm(at);
      },
      // Every write so far made durable (`createNote.js` times it, for the save's timings).
      settle: () => this.state.storage.sync(),
      // One storage transaction for `ws.apply`: all of a change lands, or none of it.
      transact: (work) => this.state.storage.transactionSync(work),
      // The changes taken for Convex's mirror, written in the transaction that takes them (`workspaceStore/mirrorOutbox.js`).
      mirror: mirrorOutbox(sql),
      // Sends them on, oldest first, one flush at a time (`workspaceStore/mirrorFlush.js`, `controlPlane/rowsMirror.js`).
      flushMirror: () => flushMirror(store, (workspaceId, changes) => createControlPlane(this.env).rowsMirror(workspaceId, changes), log),
      // A flush soon: the alarm runs at once, unless one is already set earlier. Nothing waits on it.
      mirrorSoon: () => {
        this.state.storage
          .getAlarm()
          .then(async (set) => {
            const at = Date.now();
            if (set === null || set > at) await this.state.storage.setAlarm(at);
          })
          .catch(() => {
            // The change is queued; the next write or alarm arms the flush again.
          });
      },
    };
    // The search indexes caught up on the alarm while changes wait, not only behind a search.
    store.indexBuild = indexBuilder(store);
    this.store = store;
    const tree = treeSockets(this.state, sql, this.store);
    this.store.onTreeChange = (change) => tree.changed(change);
    this.tree = tree;
    this.access = accessSockets(this.state, sql);
    // The computers this workspace owns: their rows, runs and the runner's socket (`workspaceStore/machines.js`).
    this.store.machines = workspaceMachines(sql);
    this.machines = machineSockets(this.state, sql, this.store.machines, { notify: (event) => machineEvent(this.env, event) });
    this.store.machineSockets = this.machines;
    // Convex written behind each take-away access write, before the object reports it done (`controlPlane/accessMirror.js`).
    const mirror = async (workspaceId, change) => await createControlPlane(this.env).accessMirror(workspaceId, change);
    watchMembers(this.store, this.access, this.env, { mirror });
    watchPerson(this.store, this.access, { mirror });
    return this.store;
  }

  async fetch(request) {
    // A call naming its person is their Tex's, sockets included, and nothing of the workspace's.
    if (isTexCall(request)) return await this.tex().fetch(request);
    const store = this.ready();
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const path = new URL(request.url).pathname;
      if (path === "/machine") return this.machines.accept(request);
      return path === "/access" ? this.access.accept(request) : this.tree.accept(request);
    }
    // Whether this is the first call this instance answers: a woken object, for the gateway's log line.
    const cold = this.answered !== true;
    this.answered = true;
    const served = await serveWorkspaceStore(store, request);
    const response = opOf(request) === "ws.open" && served.ok ? Response.json({ ...(await served.json()), cold }) : served;
    // Where the tree is read from changed: watchers of a workspace switched back are told to read Convex.
    if (opOf(request) === "ws.home" && response.ok) this.tree.notice({ all: true });
    // A build behind a search that left changes waiting: the alarm builds on (`workspaceStore/indexBuild.js`).
    if (INDEX_BUILDS.has(opOf(request)) && response.ok) {
      try {
        const answer = await response.clone().json();
        // Whether a build behind a search did anything: counts and a code, never a path (2026-11-04: @seyi's meaning
        // index never finished its first build, and nothing said why).
        if (opOf(request) === "ws.meaning.build") {
          console.log(JSON.stringify({ event: "meaning_build", reason: answer?.failed === true ? (typeof answer.reason === "string" ? answer.reason : "failed") : answer?.served === true ? (answer.busy === true ? "busy" : "built") : "not_served", ...(Number.isFinite(answer?.waiting) ? { meaningWaiting: answer.waiting } : {}), ...(typeof answer?.providerWords === "string" && /^[a-z ]{1,260}$/.test(answer.providerWords) ? { providerWords: answer.providerWords } : {}) }));
        }
        store.indexBuild.noted(answer);
        if (store.indexBuild.wake() !== null) this.tex().arm();
      } catch {
        // The next search's build call notes it again.
      }
    }
    return response;
  }

  /** Person-object writes still owed by member changes, sent again; then the person's Tex routines that are due. */
  async alarm() {
    const store = this.ready();
    // Changes owed to Convex's mirror go first; a flush that could not finish is tried again in 30 s.
    if (!(await store.flushMirror()).done) await store.retryLater();
    await flushReach(store);
    const tex = this.tex();
    await tex.alarm();
    // The search indexes, after Tex's routines, so a build never holds a routine back.
    if (store.indexBuild.wake() !== null && store.indexBuild.wake() <= Date.now()) await store.indexBuild.run();
    tex.arm();
  }

  async webSocketMessage(ws, raw) {
    this.ready();
    if (this.tex().owns(ws)) return this.tex().message(ws, raw);
    if (this.access.owns(ws)) return await this.access.message(ws, raw);
    if (this.machines.owns(ws)) return await this.machines.message(ws, raw);
    await this.tree.message(ws, raw);
  }

  async webSocketClose(ws) {
    this.ready();
    if (this.tex().owns(ws)) return closeQuietly(ws);
    if (this.access.owns(ws)) return this.access.closed(ws);
    if (this.machines.owns(ws)) return await this.machines.closed(ws);
    this.tree.closed(ws);
  }

  async webSocketError(ws) {
    this.ready();
    if (this.tex().owns(ws)) return closeQuietly(ws);
    if (this.access.owns(ws)) return this.access.closed(ws);
    if (this.machines.owns(ws)) return await this.machines.closed(ws);
    this.tree.closed(ws);
  }
}

/**
 * A machine run's event, handed to the texting Worker, which passes it to the
 * job's own object. Absent the binding (a self-hosted gateway without Tex, most
 * tests) it is only kept on the run's row, where the job reads it.
 */
async function machineEvent(env, event) {
  if (typeof env?.TEXTING?.machineEvent !== "function") return;
  await env.TEXTING.machineEvent(event);
}
