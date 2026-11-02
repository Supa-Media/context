/**
 * The live half of a chat's Tex page (decided by the owner, 2026-11-02: "make
 * sure that there is some kind of WebSocket connection to the box so that it
 * gets real-time updates"). The page's socket is held by the chat's own Tex
 * object, the box that keeps its notes and records, so a change made there
 * reaches the page from where it was made.
 *
 * - **Who.** The gateway decides (`http/texPage/live.js`): the console's own
 *   client, the page's own handle, a chat the person is in. It names the
 *   viewer in one header on a request it built itself, so nothing the client
 *   sent reaches here. A socket lives until the viewer's deadline (at most
 *   five minutes), then is closed with `PAGE_CLOSE_REAUTH` and the app comes
 *   back through the gateway, so a person taken out of a chat stops hearing it.
 * - **What.** Frames are `{"t":"patch","section":S,"value"?:V}`. A section with
 *   no value tells the page to read it again through the gateway, which checks
 *   access every time; jobs come with their values, polled from the texting
 *   Worker while a page is open (2 s while one runs, 15 s otherwise).
 * - **When.** Its own writes (a record, a note) and pokes (`page_poke`): a
 *   settings change, a page act, a tool's write in a watched folder.
 */

import { fetchPageJobs, jobDetail, jobsOverview, slotsOf } from "../http/texPage/jobs.js";

export const PAGE_PROTOCOL = "context.tex-page";
export const PAGE_VIEWER_HEADER = "x-tex-page-viewer";
export const PAGE_LIVE_PATH = "/page-live";
/** The longest a socket lives before the app must come back through the gateway. */
export const PAGE_SOCKET_MAX_MS = 5 * 60 * 1000;
export const PAGE_CLOSE_REAUTH = 4001;
export const POLL_RUNNING_MS = 2_000;
export const POLL_IDLE_MS = 15_000;
const TAG = "page";
/** Sections a frame may name: the overview's keys, the list kinds, and a job. */
export const PAGE_SECTIONS = new Set([
  "status",
  "thinking",
  "thinkingToday",
  "minions",
  "earlier",
  "earlierWeek",
  "tiles",
  "behind",
  "chats",
  "job",
  "jobs",
  "advisor",
  "mailcheck",
  "routines",
  "checkins",
  "about",
  "settings",
]);

const SCHEMA = ["CREATE TABLE IF NOT EXISTS page_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"];
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The viewer the gateway named, or null: a deadline, and the chat as the texting Worker knows it. */
export function readViewer(header) {
  let raw;
  try {
    raw = JSON.parse(header ?? "null");
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || typeof raw.deadline !== "number") return null;
  const chat = raw.chat;
  const jobsChat =
    chat && typeof chat.phone === "string" && /^\+[1-9]\d{6,14}$/.test(chat.phone)
      ? { phone: chat.phone }
      : chat && typeof chat.groupKey === "string" && /^[0-9a-f]{64}$/.test(chat.groupKey)
        ? { groupKey: chat.groupKey }
        : null;
  return { deadline: raw.deadline, chat: jobsChat, timeZone: typeof raw.timeZone === "string" ? raw.timeZone.slice(0, 64) : null };
}

/** One frame. */
export function patchFrame(section, value) {
  return JSON.stringify(value === undefined ? { t: "patch", section } : { t: "patch", section, value });
}

/**
 * @param {{acceptWebSocket: Function, getWebSockets: Function}} state the Durable Object's state
 * @param {{exec: Function}} sql
 * @param {object} env the Worker's bindings (`TEXTING`)
 * @param {{now?: () => number, pair?: () => [WebSocket, WebSocket], upgraded?: (client: WebSocket) => Response, waitingMail?: () => number}} [deps]
 */
export function pageLive(state, sql, env, deps = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const now = deps.now ?? (() => Date.now());
  const pair =
    deps.pair ??
    (() => {
      const made = new WebSocketPair();
      return [made[0], made[1]];
    });
  const upgraded = deps.upgraded ?? ((client) => new Response(null, { status: 101, webSocket: client }));
  /** What was last pushed for each section, so a poll pushes only what changed. Lost on hibernation: then pushed again, which is harmless. */
  const pushed = new Map();

  const meta = (key) => {
    const [row] = rows(sql.exec("SELECT v FROM page_meta WHERE k = ?", key));
    if (!row) return null;
    try {
      return JSON.parse(row.v);
    } catch {
      return null;
    }
  };
  const setMeta = (key, value) => {
    if (value === null) sql.exec("DELETE FROM page_meta WHERE k = ?", key);
    else sql.exec("INSERT INTO page_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", key, JSON.stringify(value));
  };
  const deadlineOf = (ws) => {
    try {
      const held = ws.deserializeAttachment();
      return held && held.page === true && typeof held.deadline === "number" ? held.deadline : null;
    } catch {
      return null;
    }
  };
  const close = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  };
  /** The open page sockets; one past its deadline is closed on the way. */
  const sockets = () => {
    const open = [];
    for (const ws of typeof state.getWebSockets === "function" ? state.getWebSockets(TAG) : []) {
      if (ws.readyState !== undefined && ws.readyState !== 1) continue;
      const deadline = deadlineOf(ws);
      if (deadline === null || deadline <= now()) {
        close(ws, PAGE_CLOSE_REAUTH, "reauthorize");
        continue;
      }
      open.push(ws);
    }
    return open;
  };
  const send = (frames) => {
    if (frames.length === 0) return 0;
    const open = sockets();
    for (const ws of open) {
      for (const frame of frames) {
        try {
          ws.send(frame);
        } catch {
          close(ws, 1011, "send failed");
          break;
        }
      }
    }
    return open.length;
  };

  return {
    /** Whether this socket is one of the page's. */
    owns(ws) {
      return deadlineOf(ws) !== null;
    },

    /** Open a socket for the viewer the gateway named; arms the first poll. */
    accept(request) {
      const viewer = readViewer(request.headers.get(PAGE_VIEWER_HEADER));
      if (viewer === null) return Response.json({ error: "bad_viewer" }, { status: 400 });
      const [client, server] = pair();
      state.acceptWebSocket(server, [TAG]);
      server.serializeAttachment({ page: true, deadline: Math.min(viewer.deadline, now() + PAGE_SOCKET_MAX_MS) });
      if (viewer.chat !== null) setMeta("chat", viewer.chat);
      if (viewer.timeZone !== null) setMeta("timeZone", viewer.timeZone);
      setMeta("pollAt", now());
      return upgraded(client);
    },

    /** A frame from the page: `ping` is answered, anything else (`watch`) is read and needs nothing. */
    message(ws, raw) {
      if (deadlineOf(ws) === null || deadlineOf(ws) <= now()) return close(ws, PAGE_CLOSE_REAUTH, "reauthorize");
      let frame = null;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : "null");
      } catch {
        frame = null;
      }
      if (frame?.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    },

    /** Something the page shows changed: each named section, without a value, so the page reads it again. */
    changed(sections) {
      const named = [...new Set((Array.isArray(sections) ? sections : []).filter((section) => PAGE_SECTIONS.has(section) && section !== "job"))];
      const frames = named.map((section) => patchFrame(section));
      // A record or a note can change the overview's tiles and its counts too.
      if (named.length > 0 && !named.includes("tiles")) frames.push(patchFrame("tiles"));
      return send(frames);
    },

    /** When the next poll is due, or null when no page is open. */
    pollAt() {
      if (sockets().length === 0) {
        setMeta("pollAt", null);
        pushed.clear();
        return null;
      }
      const at = meta("pollAt");
      return typeof at === "number" ? at : null;
    },

    /**
     * Read the chat's jobs and push what changed: the overview's job parts with
     * their values, and each changed job whole. Sets the next poll.
     */
    async poll() {
      if (sockets().length === 0) {
        setMeta("pollAt", null);
        return null;
      }
      const { now: at, jobs } = await fetchPageJobs(env, meta("chat"), now());
      const parts = jobsOverview(jobs, at, { timeZone: meta("timeZone"), waitingMail: deps.waitingMail?.() ?? 0 });
      const frames = [];
      for (const [section, value] of Object.entries(parts)) {
        const text = JSON.stringify(value);
        if (pushed.get(section) !== text) {
          pushed.set(section, text);
          frames.push(patchFrame(section, value));
        }
      }
      const slots = slotsOf(jobs);
      for (const job of jobs) {
        const detail = jobDetail(job, slots.get(job.id) ?? null);
        const text = JSON.stringify(detail);
        if (pushed.get(`job:${job.id}`) !== text) {
          pushed.set(`job:${job.id}`, text);
          frames.push(patchFrame("job", detail));
        }
      }
      send(frames);
      const next = now() + (jobs.some((job) => job.state === "running") ? POLL_RUNNING_MS : POLL_IDLE_MS);
      setMeta("pollAt", next);
      return next;
    },

    /** Everything kept for open pages, removed (`wipe`). */
    wipe() {
      sql.exec("DELETE FROM page_meta");
      for (const ws of typeof state.getWebSockets === "function" ? state.getWebSockets(TAG) : []) close(ws, 1000, "gone");
    },
  };
}

/** Tell a chat's Tex object that sections of its page changed. Never throws. */
export async function pokeTexPage(env, owner, sections) {
  try {
    const { callTexStore, texStoreStub } = await import("./wire.js");
    const stub = texStoreStub(env, owner);
    if (stub === null) return false;
    await callTexStore(stub, "page_poke", { sections });
    return true;
  } catch {
    return false;
  }
}
