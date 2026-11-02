/**
 * The app's access screens, kept by a workspace object (decided by the owner,
 * 2026-11-01; `/mnt/project-files/workspace-access/plan.md`, thread F).
 *
 * The gateway's `/presence/access` route (`live/accessRoute.js`) has already
 * checked who is asking and hands the object one header naming the reader:
 * which side this object answers for (`workspace` or `person`), the person,
 * their role here, their clearance, and when the socket must check again. The
 * client names only topics and writes, each checked against the side's list in
 * `accessFrames.cjs` before anything here runs.
 *
 * What each topic holds, and what each write does, is not decided here: the
 * object's access tables (threads B and C) register them as `providers`:
 *   topics[name] = { served(): boolean, rows(reader): any | Promise<any> }
 *   ops[name]    = async (reader, args) => result      (throw {code} to refuse)
 *   admit(reader) => boolean                           (false: this reader may not see this object)
 * A topic or write with no provider, or whose provider is not served yet, is
 * `not_served`, and the app keeps reading Convex. Switching back is the
 * rollback, as on the tree.
 *
 * A topic is sent again when its provider says it changed, and only to sockets
 * whose last copy differs. `lockOut(userId)` closes that person's sockets at
 * once (a member removed, a connection revoked), so they reconnect through the
 * gateway and are refused there.
 *
 * Sockets hibernate: a socket's reader, topics and what it was last sent are
 * in this object's SQLite, keyed by an id on the socket's attachment.
 */

import {
  ACCESS_CLOSE_FORBIDDEN,
  ACCESS_CLOSE_NOT_SERVED,
  ACCESS_CLOSE_REAUTH,
  ACCESS_SOCKET_MAX_MS,
  ackFrame,
  decodeClientFrame,
  isSide,
  notServedFrame,
  pongFrame,
  refusedFrame,
  rowsFrame,
} from "../../../../packages/shared/src/accessFrames.cjs";

/** The header the reader arrives in; the gateway's route sets it on a request with no other header. */
export const ACCESS_READER_HEADER = "x-access-reader";

const TAG = "access";
const ROLES = new Set(["owner", "editor", "member"]);
const SCOPES = new Set(["private", "team"]);
const MAX_GROUPS = 500;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NOTICE_GATHER_MS = 25;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_access_sockets (id TEXT PRIMARY KEY, reader TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ws_access_topics (socket TEXT NOT NULL, topic TEXT NOT NULL, sent TEXT, PRIMARY KEY (socket, topic))`,
];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The reader the gateway named, or null. Never anything the client sent. */
export function accessReaderOf(raw) {
  let reader;
  try {
    reader = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!reader || typeof reader !== "object") return null;
  if (!isSide(reader.side) || !ROLES.has(reader.role) || !SCOPES.has(reader.scope)) return null;
  if (typeof reader.userId !== "string" || !ID.test(reader.userId)) return null;
  if (typeof reader.workspaceId !== "string" || !ID.test(reader.workspaceId)) return null;
  if (!Array.isArray(reader.groups) || reader.groups.length > MAX_GROUPS) return null;
  if (!reader.groups.every((group) => typeof group === "string" && group.length > 0 && group.length <= 128)) return null;
  if (!Number.isFinite(reader.deadline)) return null;
  return {
    side: reader.side,
    userId: reader.userId,
    workspaceId: reader.workspaceId,
    role: reader.role,
    scope: reader.scope,
    groups: [...new Set(reader.groups)],
    grantId: typeof reader.grantId === "string" ? reader.grantId : null,
    deadline: reader.deadline,
  };
}

async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{acceptWebSocket: Function, getWebSockets: Function}} state  the Durable Object's state
 * @param {{exec: Function}} sql
 * @param {{now?: () => number, pair?: () => [WebSocket, WebSocket], schedule?: (fn: () => void, ms: number) => unknown, upgraded?: (client: WebSocket) => Response}} [deps]
 */
export function accessSockets(state, sql, deps = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const pair = deps.pair ?? (() => {
    const made = new WebSocketPair();
    return [made[0], made[1]];
  });
  const upgraded = deps.upgraded ?? ((client) => new Response(null, { status: 101, webSocket: client }));
  const providers = { topics: {}, ops: {}, admit: null };
  let pending = null;

  const socketId = (ws) => {
    try {
      const held = ws.deserializeAttachment();
      return held && held.access === true && typeof held.id === "string" ? held.id : null;
    } catch {
      return null;
    }
  };
  const readerFor = (id) => {
    const row = all(sql.exec("SELECT reader FROM ws_access_sockets WHERE id = ?", id))[0];
    return row ? JSON.parse(row.reader) : null;
  };
  const forget = (id) => {
    sql.exec("DELETE FROM ws_access_topics WHERE socket = ?", id);
    sql.exec("DELETE FROM ws_access_sockets WHERE id = ?", id);
  };
  const close = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  };
  const openSockets = () => state.getWebSockets(TAG).filter((ws) => ws.readyState === undefined || ws.readyState === 1);
  const served = (topic) => {
    const provider = providers.topics[topic];
    try {
      return provider !== undefined && provider.served() === true;
    } catch {
      return false;
    }
  };

  /** Whether the object still lets this reader in; a provider that throws lets nobody in. */
  const admitted = (reader) => {
    if (providers.admit === null) return true;
    try {
      return providers.admit(reader) === true;
    } catch {
      return false;
    }
  };

  const expired = (ws, id, reader) => {
    if (reader !== null && reader.deadline > now()) return false;
    forget(id);
    close(ws, ACCESS_CLOSE_REAUTH, "reauthorize");
    return true;
  };

  /** Send each of `topics` that differs from what this socket was last sent. */
  const sendTopics = async (ws, id, reader, topics) => {
    for (const topic of topics) {
      let frame;
      if (!served(topic)) frame = notServedFrame(topic);
      else {
        try {
          frame = rowsFrame(topic, await providers.topics[topic].rows(reader));
        } catch {
          frame = notServedFrame(topic);
        }
      }
      const sent = await digest(frame);
      const held = all(sql.exec("SELECT sent FROM ws_access_topics WHERE socket = ? AND topic = ?", id, topic))[0];
      if (held === undefined || held.sent === sent) continue;
      sql.exec("UPDATE ws_access_topics SET sent = ? WHERE socket = ? AND topic = ?", sent, id, topic);
      ws.send(frame);
    }
  };

  const flush = async () => {
    const notice = pending;
    pending = null;
    if (notice === null) return;
    for (const ws of openSockets()) {
      const id = socketId(ws);
      if (id === null) continue;
      const reader = readerFor(id);
      if (expired(ws, id, reader)) continue;
      const held = all(sql.exec("SELECT topic FROM ws_access_topics WHERE socket = ?", id)).map((row) => row.topic);
      await sendTopics(ws, id, reader, notice.all ? held : held.filter((topic) => notice.topics.has(topic)));
    }
  };

  const runOp = async (reader, frame) => {
    const handler = providers.ops[frame.op];
    if (typeof handler !== "function") return refusedFrame(frame.id, "not_served");
    try {
      return ackFrame(frame.id, await handler(reader, frame.args));
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "failed";
      return refusedFrame(frame.id, code);
    }
  };

  return {
    /** Threads B and C register what each topic holds and what each write does. */
    provide({ topics = {}, ops = {}, admit } = {}) {
      Object.assign(providers.topics, topics);
      Object.assign(providers.ops, ops);
      if (typeof admit === "function") providers.admit = admit;
      this.changed();
    },

    /** Open a socket for the reader the gateway named. */
    accept(request) {
      const reader = accessReaderOf(request.headers.get(ACCESS_READER_HEADER));
      if (reader === null) return new Response(JSON.stringify({ error: "bad_reader" }), { status: 400 });
      const [client, server] = pair();
      state.acceptWebSocket(server, [TAG]);
      if (!admitted(reader)) {
        close(server, ACCESS_CLOSE_FORBIDDEN, "forbidden");
        return upgraded(client);
      }
      const live = new Set(openSockets().map(socketId).filter((held) => held !== null));
      for (const { id: held } of all(sql.exec("SELECT id FROM ws_access_sockets"))) if (!live.has(held)) forget(held);
      const id = crypto.randomUUID();
      const deadline = Math.min(reader.deadline, now() + ACCESS_SOCKET_MAX_MS);
      sql.exec("INSERT INTO ws_access_sockets (id, reader) VALUES (?, ?)", id, JSON.stringify({ ...reader, deadline }));
      server.serializeAttachment({ access: true, id });
      return upgraded(client);
    },

    /** Whether `ws` is one of this module's sockets (the object also holds tree sockets). */
    owns(ws) {
      return socketId(ws) !== null;
    },

    async message(ws, raw) {
      const id = socketId(ws);
      if (id === null) return close(ws, 1008, "unknown socket");
      const reader = readerFor(id);
      if (expired(ws, id, reader)) return;
      if (!admitted(reader)) {
        forget(id);
        return close(ws, ACCESS_CLOSE_FORBIDDEN, "forbidden");
      }
      const frame = decodeClientFrame(reader.side, typeof raw === "string" ? raw : null);
      if (frame === null) return close(ws, 1008, "bad frame");
      if (frame.t === "ping") return ws.send(pongFrame());
      if (frame.t === "op") return ws.send(await runOp(reader, frame));
      const held = new Set(all(sql.exec("SELECT topic FROM ws_access_topics WHERE socket = ?", id)).map((row) => row.topic));
      for (const topic of held) if (!frame.topics.includes(topic)) sql.exec("DELETE FROM ws_access_topics WHERE socket = ? AND topic = ?", id, topic);
      const added = frame.topics.filter((topic) => !held.has(topic));
      for (const topic of added) sql.exec("INSERT INTO ws_access_topics (socket, topic, sent) VALUES (?, ?, '')", id, topic);
      await sendTopics(ws, id, reader, added);
      // Nothing asked for is read from this object yet: the app reads Convex and asks again later, holding no socket.
      if (frame.topics.length > 0 && !frame.topics.some(served)) {
        forget(id);
        close(ws, ACCESS_CLOSE_NOT_SERVED, "not served");
      }
    },

    closed(ws) {
      const id = socketId(ws);
      if (id !== null) forget(id);
    },

    /** Topics changed (all of them when none is named); subscribers are sent them again after a short gather. */
    changed(topics = null) {
      if (pending === null) {
        pending = { topics: new Set(), all: false };
        schedule(() => {
          flush().catch(() => {});
        }, NOTICE_GATHER_MS);
      }
      if (topics === null) pending.all = true;
      else for (const topic of topics) pending.topics.add(topic);
    },

    /** Close every socket this person holds here, at once: they reconnect through the gateway, which decides again. */
    lockOut(userId) {
      for (const ws of openSockets()) {
        const id = socketId(ws);
        if (id === null) continue;
        const reader = readerFor(id);
        if (reader !== null && reader.userId !== userId) continue;
        forget(id);
        close(ws, ACCESS_CLOSE_REAUTH, "reauthorize");
      }
    },

    /** The people holding a socket here now. */
    readers() {
      const held = new Set();
      for (const ws of openSockets()) {
        const id = socketId(ws);
        const reader = id === null ? null : readerFor(id);
        if (reader !== null) held.add(reader.userId);
      }
      return [...held];
    },

    /** For tests: run a gathered notice now. */
    flush,
  };
}
