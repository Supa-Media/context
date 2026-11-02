/** Types for `accessFrames.cjs`; see that file for the protocol. */

export type AccessSide = "workspace" | "person";

export declare const ACCESS_PROTOCOL: "context.access";
export declare const ACCESS_SOCKET_PATH: "/presence/access";
export declare const ACCESS_SIDES: AccessSide[];
export declare const ACCESS_TOPICS: Record<AccessSide, string[]>;
export declare const ACCESS_OPS: Record<AccessSide, string[]>;
export declare const ACCESS_SOCKET_MAX_MS: number;
export declare const ACCESS_CLOSE_REAUTH: number;
export declare const ACCESS_CLOSE_NOT_SERVED: number;
export declare const ACCESS_CLOSE_FORBIDDEN: number;

export type ClientFrame =
  | { t: "ping" }
  | { t: "sub"; topics: string[] }
  | { t: "op"; id: string; op: string; args: Record<string, unknown> };
export type ServerFrame =
  | { t: "pong" }
  | { t: "not_served"; topic: string }
  | { t: "rows"; topic: string; rows: unknown }
  | { t: "ack"; id: string; ok: true; result: unknown }
  | { t: "ack"; id: string; ok: false; error: string };

export declare function isSide(side: unknown): side is AccessSide;
export declare function topicOk(side: unknown, topic: unknown): boolean;
export declare function opOk(side: unknown, op: unknown): boolean;
export declare function decodeClientFrame(side: AccessSide, raw: unknown): ClientFrame | null;
export declare function decodeServerFrame(side: AccessSide, raw: unknown): ServerFrame | null;
export declare function subFrame(topics: Iterable<string>): string;
export declare function opFrame(id: string, op: string, args?: Record<string, unknown>): string;
export declare function pingFrame(): string;
export declare function rowsFrame(topic: string, rows: unknown): string;
export declare function notServedFrame(topic: string): string;
export declare function ackFrame(id: string, result?: unknown): string;
export declare function refusedFrame(id: string, error: string): string;
export declare function pongFrame(): string;
