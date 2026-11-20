import type { ChatLine } from "./appChatGateway";
import { isPending, type AskChoice, type ReactionEmoji } from "./appChatGateway";
import type { PickedFile } from "./appChatFiles";

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
   * Send words, up to `MAX_ATTACHMENTS` pictures and files together (each picture shrunk on this device to a JPEG under
   * `MAX_PICTURE_BYTES` before it goes; each file up to `MAX_FILE_BYTES`), or both, optionally as a reply to a row.
   */
  send: (text: string, options?: { pictures?: readonly Blob[]; files?: readonly PickedFile[]; replyTo?: string | null }) => void;
  /** Save a file on a row to the device, asked for by id and named as the row names it. Nothing is saved where there is no document. */
  downloadFile: (id: string, name: string) => void;
  retry: (localId: string) => void;
  answer: (rowId: string, choice: AskChoice) => void;
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
}

/** Polled once a second while a turn is open, and for this long after Tex starts typing. */
export const FAST_MS = 1_000;
/** Polled this often otherwise, so a background job's report shows up without a reload. */
export const SLOW_MS = 10_000;
/** The fast poll stops after this long, even if Tex is still typing or has not answered. */
export const FAST_WINDOW_MS = 120_000;

export const EMPTY: State = {
  phase: "idle",
  lines: [],
  typing: false,
  error: null,
  loadError: null,
  sendsInFlight: 0,
  answers: {},
  waiting: null,
};

/** Tex's own texts on the page. A turn is over when this grows. */
export function texCountOf(lines: readonly ChatLine[]): number {
  return lines.filter((line) => !isPending(line) && line.who === "tex").length;
}
