/** Types for `texSetOps.cjs`; see that file. */
import type { Conversation, Message } from "../../shared/src/texSets.cjs";
export type SetOp =
  | { op: "title"; value: string }
  | { op: "kind"; value: "one" | "group" }
  | { op: "members"; value: string[] }
  | { op: "set"; value: "training" | "dev" }
  | { op: "add"; msg: Partial<Message> & { who: string; text: string }; after?: string | null }
  | { op: "edit"; msg: string; field: "who" | "text" | "kind" | "to" | "tex" | "pics"; value: unknown }
  | { op: "remove"; msg: string }
  | { op: "move"; msg: string; before: string | null }
  | { op: "label"; msg: string; node: string; value: Record<string, unknown> | null }
  | { op: "field"; msg: string; node: string; field: string; value: unknown }
  | { op: "rec"; msg: string; node: string; value: Record<string, unknown> | null }
  | { op: "put"; convo: Conversation }
  | { op: "addMsg"; at: number; msg: Partial<Message> & { who: string; text: string } }
  | { op: "editMsg"; id: string; patch: Partial<Pick<Message, "who" | "tex" | "text" | "kind" | "to">> }
  | { op: "removeMsg"; id: string }
  | { op: "moveMsg"; id: string; at: number }
  | { op: "label"; id: string; node: string; label: Record<string, unknown> | null };
export const OPEN_SETS: readonly ("training" | "dev")[];
export const MAX_OPS: number;
export const MAX_PICS: number;
export class OpError extends Error {}
/** A message's pictures checked (at most `MAX_PICS`, https, picture types): the sound list, or a thrown `OpError`. */
export function checkPics(value: unknown): { url: string; type?: string; name?: string }[];
export function apply<C extends Conversation>(convo: C, op: SetOp): C;
export function applyOps<C extends Conversation>(convo: C, ops: SetOp[]): { convo: C; keys: string[]; said: string[]; full: string[] };
export function keysOf(op: SetOp): string[];
export function conflicts(mine: string[], theirs: string[]): string[];
export function describe(op: SetOp, full?: boolean): string;
export function blank(args: { id: string; title?: string; set?: "training" | "dev"; kind?: "one" | "group"; members?: string[] }): Conversation;
