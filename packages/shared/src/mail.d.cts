/** Types for `mail.cjs`; see that file for the format and the reasons. */

import type { CommentChange, CommentsBlock } from "./comments.cjs";

export interface MailEvent {
  at: string;
  /** A joined name, or a person's `@handle`. */
  from: string;
  /** The app an agent wrote from, or null for a person. */
  app: string | null;
  kind: "joined" | "mail";
  /** `everyone` or a joined name; null for a join. */
  to: string | null;
  text: string;
  /** The entry's lines in the file, `[start, end)`. */
  start: number;
  end: number;
}

export declare const MAIL_INFO: "mail";
export declare const EVERYONE: "everyone";
export declare function findMailBlock(text: string): CommentsBlock | null;
export declare function parseMail(text: string): { block: CommentsBlock | null; events: MailEvent[] };
export declare function mailName(raw: unknown): string | null;
export declare function appName(raw: unknown): string | null;
export declare function appendMail(
  text: string,
  entry: { at?: string; from: string; app?: string | null; kind: "joined" | "mail"; to?: string; text?: string },
): { changes: CommentChange[]; error?: undefined } | { error: string; changes?: undefined };
export declare function stripMail(text: string): string;
export declare function newFor(events: MailEvent[], name: string, since: string | null): MailEvent[];
export declare function describeEntry(event: MailEvent): string;
