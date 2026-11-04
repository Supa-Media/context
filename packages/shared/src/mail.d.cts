/** Types for `mail.cjs`; see that file for the format and the reasons. */

import type { CommentChange, CommentsBlock } from "./comments.cjs";

export type MailKind = "note" | "ask" | "interrupt";

export interface MailEvent {
  at: string;
  /** A joined name, or a person's `@handle`. */
  from: string;
  /** The app an agent wrote from, or null for a person. */
  app: string | null;
  kind: "joined" | "mail";
  /** `everyone` or a joined name; null for a join. */
  to: string | null;
  /** `note` when untagged; null for a join. */
  mailKind: MailKind | null;
  text: string;
  /** The entry's lines in the file, `[start, end)`. */
  start: number;
  end: number;
}

export declare const MAIL_INFO: "mail";
export declare const EVERYONE: "everyone";
export declare const MAIL_KINDS: readonly ["note", "ask", "interrupt"];
export declare const MAX_ASK_DEPTH: 3;
export declare const MAX_PER_PAIR_PER_HOUR: 20;
export declare function findMailBlock(text: string): CommentsBlock | null;
export declare function parseMail(text: string): { block: CommentsBlock | null; events: MailEvent[] };
export declare function mailName(raw: unknown): string | null;
export declare function appName(raw: unknown): string | null;
export declare function appendMail(
  text: string,
  entry: { at?: string; from: string; app?: string | null; kind: "joined" | "mail"; to?: string; text?: string; mailKind?: MailKind },
): { changes: CommentChange[]; error?: undefined } | { error: string; changes?: undefined };
export declare function stripMail(text: string): string;
export declare function newFor(events: MailEvent[], name: string, since: string | null): MailEvent[];
export declare function describeEntry(event: MailEvent): string;
export declare function pairCount(
  events: MailEvent[],
  from: string,
  to: string,
  nowMs: number,
  windowMs?: number,
): number;
export declare function askDepth(events: MailEvent[], from: string): number;
