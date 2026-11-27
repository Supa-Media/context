/** Types for `cellComments.cjs`; see that file for the format and the reasons. */

import type { CommentEvent, CommentThread } from "./comments.cjs";

export declare const COMMENTS_TYPE: "comments";
export declare const COMMENTS_COLUMN: "comments";
export declare function cellThreads(cell: string): CommentThread[];
export declare function newCellThreadId(cells: string[], random?: () => number): string;
export declare function addCellThread(
  cell: string,
  options: { id: string; column: string; author: string; body: string; at?: string | number | Date },
): { cell: string; error?: undefined } | { error: string; cell?: undefined };
export declare function appendCellEvent(
  cell: string,
  options: { thread: string; kind: CommentEvent["kind"]; author: string; body?: string; at?: string | number | Date },
): { cell: string; error?: undefined } | { error: string; cell?: undefined };
export declare function deleteCellComment(
  cell: string,
  options: { thread: string; index: number; expect?: { at: string; author: string } },
): { cell: string; error?: undefined } | { error: string; cell?: undefined };
export declare function renameCellColumn(cell: string, from: string, to: string): string;
