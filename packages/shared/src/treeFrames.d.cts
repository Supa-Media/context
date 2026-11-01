/** Types for `treeFrames.cjs`; see that file for the protocol. */

export declare const TREE_PROTOCOL: "context.tree";
export declare const TREE_SOCKET_PATH: "/presence/tree";
export declare const TREE_WATCH_MAX: number;
export declare const TREE_SOCKET_MAX_MS: number;
export declare const TREE_CLOSE_REAUTH: number;
export declare const TREE_CLOSE_NOT_SERVED: number;

export type ClientFrame = { t: "ping" } | { t: "watch"; folders: string[] };
export type ServerFrame =
  | { t: "pong" }
  | { t: "not_served" }
  | { t: "listing"; folder: string; page: { path: string; entries: unknown[]; [key: string]: unknown } };

export declare function decodeClientFrame(raw: unknown): ClientFrame | null;
export declare function decodeServerFrame(raw: unknown): ServerFrame | null;
export declare function watchFrame(folders: Iterable<string>): string;
export declare function pingFrame(): string;
export declare function listingFrame(folder: string, page: unknown): string;
export declare function notServedFrame(): string;
export declare function pongFrame(): string;
