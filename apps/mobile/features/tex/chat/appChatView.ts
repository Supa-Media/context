import type { ChatLine } from "./appChatGateway";
import { isPending, type AnswerChoice, type AskChoice, type LiveRun, type ReactionEmoji } from "./appChatGateway";

/** What the chat page draws, and what a person can do on it. */
export interface AppChatView {
  /** Whether this console can chat at all. False means nothing is asked. */
  available: boolean;
  /** `idle` until the first read, `listed` once one came back, `failed` when the first read did not. */
  phase: "idle" | "listed" | "failed";
  /** Every line on the page, oldest first: the app chat's rows and the person's own texts still sending. */
  lines: ChatLine[];
  /** True while Tex is working on something: its typing mark is fresh, or a turn is open. */
  busy: boolean;
  /** True while a text of the person's is being sent. The composer waits for it. */
  sending: boolean;
  /** One short sentence for the line above the composer, or `null`. */
  error: string | null;
  /** The answer the person gave to each approval this session: `approve` or `deny`. */
  answers: Record<string, AskChoice>;
  /**
   * Send words, up to `MAX_PICTURES` pictures (each shrunk on this device to a JPEG under `MAX_PICTURE_BYTES` before it
   * goes), or both, optionally as a reply to a row.
   */
  send: (text: string, options?: { pictures?: readonly Blob[]; replyTo?: string | null }) => void;
  retry: (localId: string) => void;
  answer: (rowId: string, choice: AskChoice) => void;
  /**
   * The answer to a card (`row.ask.card`): send it, with the words the person changed when they changed them, or hold it
   * back. Shown at once (sending, or held), undone when the route refuses it.
   */
  decide: (rowId: string, choice: AnswerChoice, body?: string) => void;
  /** A tapback on any row; shown at once, undone if the route refuses it. */
  react: (rowId: string, emoji: ReactionEmoji) => void;
  /** New words for one of the person's `editable` rows; shown at once, undone if the route refuses it. */
  edit: (rowId: string, text: string) => void;
  /** Take back one of the person's `editable` rows; shown at once, undone if the route refuses it. */
  unsend: (rowId: string) => void;
  /** An object URL for a picture id, or `null` while it loads (asking for it starts the load) or when it failed. */
  pictureUrl: (id: string) => string | null;
  /** The person is typing: asks the gateway to warm the model's cache, at most once every `WARM_AGAIN_MS`. */
  typing: () => void;
  /** The turn running now, for the live run card; null when none runs. */
  run: LiveRun | null;
  /** Stop the turn running now (the stop key, Esc). What Tex already did stays. */
  stop: () => void;
  /** Try again on one of the person's texts that shows failed or stopped. */
  retryRow: (rowId: string) => void;
  /** One short line shown above the composer for a moment, or null. */
  toast: string | null;
}

export interface State {
  phase: AppChatView["phase"];
  lines: ChatLine[];
  typing: boolean;
  /** A send or an answer that did not go through. */
  error: string | null;
  /** A read that did not go through. Cleared by the next read that does. */
  loadError: string | null;
  sendsInFlight: number;
  answers: Record<string, AskChoice>;
  /** A turn the person opened (a text or an answer), until Tex's next text or the give-up. */
  waiting: { texCount: number } | null;
  /** The turn running now, its steps as they come (`liveSteps.js`). */
  run: LiveRun | null;
  /** One short line shown above the composer for a moment (the stop's). */
  toast: string | null;
}

/** After a read that failed, the chat is read again this much later. */
export const RETRY_MS = 10_000;
/** A turn the person opened counts as Tex working for at most this long, if Tex says nothing. */
export const FAST_WINDOW_MS = 120_000;
/** How long the stop's toast shows. */
export const TOAST_MS = 3_000;

export const EMPTY: State = {
  phase: "idle",
  lines: [],
  typing: false,
  error: null,
  loadError: null,
  sendsInFlight: 0,
  answers: {},
  waiting: null,
  run: null,
  toast: null,
};

/** Tex's own texts on the page. A turn is over when this grows. */
export function texCountOf(lines: readonly ChatLine[]): number {
  return lines.filter((line) => !isPending(line) && line.who === "tex").length;
}
