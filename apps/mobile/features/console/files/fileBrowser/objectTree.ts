/**
 * The file tree's socket to the workspace's object (`GET /presence/tree` on the
 * gateway; decided by the owner, 2026-11-01). Each watched folder arrives as
 * the server's listing at this person's clearance, and again whenever it
 * changes for them.
 *
 * The console grant's token is traded for a one-use ticket, offered as a
 * subprotocol beside `context.tree`, so no token is on the socket at all.
 *
 * What the socket can say, and what the tree does about it:
 * - a listing: lay it down as the server's answer for that folder;
 * - a head (asked for with `head`): what this person may see in the workspace
 *   changed when it moves, the cue a device's copy catches up on (`useNodeFeed.ts`);
 * - `not_served` (or the gateway has no object for this workspace): read the
 *   tree from Convex as before, and ask the object again after a while, so a
 *   workspace switched over later moves to it without a reload;
 * - closed to be authorized again (every five minutes, or a grant expiring):
 *   reconnect at once with a fresh grant, which is how a membership taken
 *   away stops the feed;
 * - anything else: reconnect after a growing wait.
 */

import {
  decodeServerFrame,
  pingFrame,
  TREE_CLOSE_NOT_SERVED,
  TREE_CLOSE_REAUTH,
  TREE_PROTOCOL,
  TREE_SOCKET_PATH,
  watchFrame,
} from "@context/shared/src/treeFrames.cjs";
import { fetchLiveTicket, ticketProtocols } from "@context/shared/src/liveTicket.cjs";
import type { FolderListing } from "../types";

/** How long a workspace the object does not serve reads Convex before the object is asked again. */
export const NOT_SERVED_RETRY_MS = 5 * 60_000;
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export function treeSocketUrl(gatewayOrigin: string): string {
  const url = new URL(TREE_SOCKET_PATH, gatewayOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/** The socket's subprotocols: its protocol and a one-use ticket, never the token (`apps/mcp/src/live/ticket.js`). */
export function treeSocketProtocols(ticket: string): string[] {
  return ticketProtocols(TREE_PROTOCOL, ticket);
}

export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, failures));
}

export interface ObjectTreeEvents {
  /** One folder's listing from the object. */
  onListing: (folder: string, page: FolderListing) => void;
  /** Whether the object serves this workspace's tree now; `false` means read Convex. */
  onServed: (served: boolean) => void;
  /** The workspace's change signal for this person, when asked for with `head`. */
  onHead?: (token: string) => void;
}

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ObjectTreeOptions extends ObjectTreeEvents {
  gatewayOrigin: string;
  /** Ask for the workspace's change signal as well as the folders (`onHead`). */
  head?: boolean;
  /** The console grant's token; `refresh` mints a new one. Rejects when there is none. */
  token: (refresh: boolean) => Promise<string>;
  /** For tests: the socket and the clock. */
  open?: (url: string, protocols: string[]) => SocketLike;
  /** For tests: trade the token for a socket ticket (`POST /presence/ticket`). */
  ticket?: (token: string) => Promise<string>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ObjectTree {
  /** The folders to keep live; sent now when open, and again on every reconnect. */
  watch(folders: readonly string[]): void;
  close(): void;
}

const OPEN = 1;

export function openObjectTree(options: ObjectTreeOptions): ObjectTree {
  const open = options.open ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as SocketLike);
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let folders: readonly string[] = [];
  let socket: SocketLike | null = null;
  let stopped = false;
  let failures = 0;
  let refresh = false;
  let retry: unknown = null;
  let ping: unknown = null;

  const clear = () => {
    if (retry !== null) clearTimer(retry);
    if (ping !== null) clearTimer(ping);
    retry = null;
    ping = null;
  };
  const later = (ms: number) => {
    clear();
    if (!stopped) retry = setTimer(() => void connect(), ms);
  };
  const keepAlive = () => {
    ping = setTimer(() => {
      if (socket?.readyState === OPEN) socket.send(pingFrame());
      keepAlive();
    }, PING_MS);
  };

  const connect = async () => {
    if (stopped) return;
    let token: string;
    try {
      token = await options.token(refresh);
    } catch {
      failures += 1;
      return later(failures >= 3 ? NOT_SERVED_RETRY_MS : backoffMs(failures - 1));
    }
    refresh = false;
    if (stopped) return;
    // The socket carries a one-use ticket, never the token (`apps/mcp/src/live/ticket.js`).
    let ticket: string;
    try {
      ticket = await (options.ticket ?? ((value: string) => fetchLiveTicket({ gatewayOrigin: options.gatewayOrigin, token: value, socket: TREE_SOCKET_PATH })))(token);
    } catch (error) {
      failures += 1;
      // A token the gateway refused is minted afresh next time.
      if ((error as { status?: number })?.status === 401) refresh = true;
      return later(failures >= 3 ? NOT_SERVED_RETRY_MS : backoffMs(failures - 1));
    }
    if (stopped) return;
    let opened = false;
    let notServed = false;
    const live = open(treeSocketUrl(options.gatewayOrigin), treeSocketProtocols(ticket));
    socket = live;
    live.onopen = () => {
      opened = true;
      live.send(watchFrame(folders, { head: options.head === true }));
      keepAlive();
    };
    live.onmessage = (event) => {
      const frame = decodeServerFrame(typeof event.data === "string" ? event.data : null);
      if (frame === null) return;
      if (frame.t === "not_served") {
        notServed = true;
        return;
      }
      if (frame.t === "head") {
        failures = 0;
        options.onServed(true);
        options.onHead?.(frame.token);
        return;
      }
      if (frame.t === "listing") {
        failures = 0;
        options.onServed(true);
        options.onListing(frame.folder, frame.page as unknown as FolderListing);
      }
    };
    live.onerror = () => {};
    live.onclose = (event) => {
      if (socket === live) socket = null;
      clear();
      if (stopped) return;
      if (notServed || event.code === TREE_CLOSE_NOT_SERVED) {
        options.onServed(false);
        return later(NOT_SERVED_RETRY_MS);
      }
      if (event.code === TREE_CLOSE_REAUTH) return later(0);
      options.onServed(false);
      failures += 1;
      // Refused before it opened: the grant may be the reason, so the next try mints a new one, once. A gateway
      // that keeps refusing (no object for this workspace, an older deployment) is asked again only after a while,
      // so the tree reads Convex and no grant is minted every few seconds.
      if (!opened) {
        refresh = failures === 1;
        if (failures >= 3) return later(NOT_SERVED_RETRY_MS);
      }
      later(backoffMs(failures - 1));
    };
  };

  void connect();
  return {
    watch(next) {
      folders = [...next];
      if (socket?.readyState === OPEN) socket.send(watchFrame(folders, { head: options.head === true }));
    },
    close() {
      stopped = true;
      clear();
      const live = socket;
      socket = null;
      try {
        live?.close(1000, "done");
      } catch {
        // Already closing.
      }
    },
  };
}
