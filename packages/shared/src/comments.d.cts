/** Types for `comments.cjs`; see that file for the format and the reasons. */

export interface CommentChange {
  from: number;
  to: number;
  insert: string;
}

export interface CommentEvent {
  at: string;
  author: string;
  kind: "comment" | "resolved" | "reopened";
  text: string;
  /** The event's lines in the file, `[start, end)`. */
  start: number;
  end: number;
}

export interface CommentThread {
  id: string;
  quote: string;
  events: CommentEvent[];
  status: "open" | "resolved";
  anchored: boolean;
  headerStart: number;
  end: number;
}

export interface CommentAnchor {
  id: string;
  /** Where the opening marker starts. */
  openStart: number;
  /** The highlighted words, `[from, to)`. */
  from: number;
  to: number;
  /** Where the closing marker ends. */
  closeEnd: number;
}

export interface CommentsBlock {
  start: number;
  end: number;
  info: string;
  bodyStart: number;
  bodyEnd: number;
  closed: boolean;
}

export declare const COMMENTS_INFO: "comments";
export declare const MARKER_RE: RegExp;
export declare function openMarker(id: string): string;
export declare function closeMarker(id: string): string;
export declare function findBlock(text: string): CommentsBlock | null;
export declare function findAnchors(text: string): Map<string, CommentAnchor>;
export declare function parseComments(text: string): {
  block: CommentsBlock | null;
  threads: CommentThread[];
  anchors: Map<string, CommentAnchor>;
};
export declare function sanitizeAuthor(name: string): string;
export declare function newThreadId(text: string, random?: () => number): string;
export declare function locateQuote(
  text: string,
  quote: string,
  occurrence?: number,
): { from: number; to: number; error?: undefined } | { error: string };
export declare function addThread(
  text: string,
  options: {
    quote?: string;
    occurrence?: number;
    from?: number;
    to?: number;
    author: string;
    body: string;
    at?: Date | string;
    id?: string;
    random?: () => number;
  },
): { id: string; changes: CommentChange[]; error?: undefined } | { error: string };
export declare function appendEvent(
  text: string,
  options: {
    thread: string;
    kind: "comment" | "resolved" | "reopened";
    author: string;
    body?: string;
    at?: Date | string;
  },
): { changes: CommentChange[]; error?: undefined } | { error: string };
export declare function deleteComment(
  text: string,
  options: {
    thread: string;
    /** Which comment, counting the thread's comments from 0; 0 deletes the thread. */
    index: number;
    /** The comment as the reader saw it; a mismatch is refused. */
    expect?: { at: string; author: string };
  },
): { changes: CommentChange[]; error?: undefined } | { error: string };
export declare function applyChanges(text: string, changes: readonly CommentChange[]): string;
export declare function stripComments(text: string): string;
export declare function describeComments(text: string): string | null;
