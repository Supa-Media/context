import type { DictationFailure } from "./dictation";
import type { DictationEngine, DictationHandlers } from "./engine";

/**
 * Speech to words in a browser, over the Web Speech API.
 *
 * ## Why this and not the meeting recorder
 *
 * `capture/audio.web.ts` exists two directories away and already turns a
 * microphone into text. It is the wrong tool here and the reason is latency,
 * not tidiness: it rotates `SEGMENT_MS` chunks to a Convex action running
 * Whisper, so the first word appears seconds after it was said and nothing is
 * ever provisional. Dictation is judged on the opposite property — the mock
 * draws a guess that updates several times a second — and a caret that trails
 * half a minute behind the speaker is not the same feature made slower, it is
 * a different and much worse one.
 *
 * `SpeechRecognition` gives interim results, runs on the device on every engine
 * that implements it, and costs nothing per minute. Two things follow that are
 * worth saying out loud rather than discovering:
 *
 *  - **Nothing leaves this machine through *this file*.** No audio is read by
 *    it, uploaded by it or stored by it — and that is a smaller claim than it
 *    looks, because the browser's own engine may well use a network service of
 *    its vendor's. Chrome's does. Which browsers do is theirs to disclose and
 *    ours not to paper over, so `DICTATION_SENTENCE` names the uncertainty
 *    instead of resolving it in the direction that flatters us.
 *  - **It is not universal.** Firefox ships no implementation at all. That is
 *    an `available: false` with a sentence, not a broken button: see
 *    `NO_ENGINE`.
 *
 * ## The restart loop, which is the bug this file mainly exists to not have
 *
 * Chrome ends a recognition session on its own after a stretch of silence, even
 * with `continuous = true`. Left alone, dictation dies quietly a few seconds
 * into a pause and the capsule keeps claiming to listen. So `onend` restarts —
 * and a naive restart is worse than the disease, because an engine that is
 * failing to start (no device, a revoked permission mid-session) ends
 * immediately and the restart becomes a hot loop hammering the microphone.
 *
 * `RESTART_FLOOR_MS` is the guard: a session that ended almost as soon as it
 * began does not count as a silence timeout, and three of those in a row is
 * reported as `unreachable` rather than retried forever.
 */

/**
 * The slice of `SpeechRecognition` this file uses.
 *
 * Declared locally rather than pulled from `lib.dom`: the app's TypeScript
 * config targets React Native, where those globals do not exist, and a
 * `/// <reference lib="dom" />` here would put the whole DOM in scope for a
 * module the native bundle also type-checks.
 */
interface SpeechResultAlternative {
  readonly transcript: string;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechResultAlternative | undefined;
}
interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult | undefined;
}
interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}
interface SpeechErrorEvent {
  readonly error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Said when the browser has no speech engine to offer. Firefox, mainly. */
export const NO_ENGINE =
  "This browser has no dictation engine. Chrome, Edge and Safari do; you can also record a meeting here instead.";

/**
 * A session shorter than this did not end because somebody stopped talking.
 *
 * 700ms is well under the shortest silence timeout any engine uses and well
 * over the time a healthy `start()` takes to produce its first event, so it
 * separates "quiet room" from "this is not going to work" without needing to
 * know which browser it is talking to.
 */
const RESTART_FLOOR_MS = 700;

/** Three instant deaths in a row is a broken engine, not a pause. */
const MAX_INSTANT_RESTARTS = 3;

function constructor(): SpeechRecognitionCtor | null {
  const scope = globalThis as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * The engine's own error names, in this feature's words.
 *
 * `no-speech` and `aborted` are deliberately absent: neither is a failure.
 * `no-speech` is a quiet room, and `aborted` is what our own `abandon()`
 * causes — reporting either would put a red card over somebody who simply
 * paused, or who pressed Discard.
 */
export function failureFor(error: string): DictationFailure | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "audio-capture":
      return "no-microphone";
    case "network":
    case "language-not-supported":
    case "bad-grammar":
      return "unreachable";
    case "no-speech":
    case "aborted":
      return null;
    default:
      return "unreachable";
  }
}

/**
 * Split one `onresult` event into the settled phrases and the current guess.
 *
 * Exported because this is the part with an off-by-one in it. `resultIndex` is
 * where *this* event's news starts, but a result already reported as interim
 * can be re-reported as final later in the same list, so the loop runs from
 * `resultIndex` to the end and finals are collected in order rather than
 * assumed to be one.
 */
export function readResults(event: SpeechResultEvent): { finals: string[]; interim: string } {
  const finals: string[] = [];
  let interim = "";
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (result === undefined) continue;
    const text = result[0]?.transcript ?? "";
    if (result.isFinal) finals.push(text);
    else interim += text;
  }
  return { finals, interim };
}

export function createDictationEngine(): DictationEngine {
  const Recognition = constructor();
  if (Recognition === null) {
    return {
      available: false,
      unavailable: NO_ENGINE,
      open: (handlers) => handlers.error("unsupported"),
      finalize: () => {},
      abandon: () => {},
    };
  }

  let session: SpeechRecognitionLike | null = null;
  /** Whether a session ending should be restarted or reported as the end. */
  let wanted = false;
  let startedAt = 0;
  let instantRestarts = 0;
  let sink: DictationHandlers | null = null;

  /**
   * Take our callbacks off a recognition object.
   *
   * **This is what makes Discard deaf**, and it is the reason `close()` does it
   * before `abort()` rather than after. `abort()` is asynchronous in every
   * engine, so a result the browser has already decided to deliver can arrive
   * afterwards — and inserting that would be text appearing in somebody's note
   * *after* they refused it. A browser dispatches to whatever `onresult` holds
   * at dispatch time, so nulling it is the whole of the guard; a separate
   * "ignore results now" flag would be a second one nothing exercises.
   */
  const detach = (target: SpeechRecognitionLike) => {
    target.onresult = null;
    target.onerror = null;
    target.onend = null;
  };

  const close = () => {
    const current = session;
    session = null;
    wanted = false;
    if (current !== null) detach(current);
    return current;
  };

  const launch = () => {
    const handlers = sink;
    if (handlers === null) return;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // The page's language, then the engine's own default. Not a stored
    // preference: somebody switching languages mid-note is rarer than somebody
    // being handed the wrong one by a setting they set once.
    const documentLang = (globalThis as { document?: { documentElement?: { lang?: string } } })
      .document?.documentElement?.lang;
    if (documentLang !== undefined && documentLang !== "") recognition.lang = documentLang;

    recognition.onresult = (event) => {
      const { finals, interim } = readResults(event);
      for (const text of finals) handlers.final(text);
      // Reported even when empty: a final that consumed the guess has to clear
      // the ghost, and the caller's reducer only learns that from this call.
      handlers.interim(interim);
    };

    recognition.onerror = (event) => {
      const reason = failureFor(event.error);
      if (reason === null) return;
      close();
      sink = null;
      handlers.error(reason);
    };

    recognition.onend = () => {
      if (session !== recognition) return;
      const lived = Date.now() - startedAt;
      if (!wanted) {
        close();
        sink = null;
        handlers.ended();
        return;
      }
      instantRestarts = lived < RESTART_FLOOR_MS ? instantRestarts + 1 : 0;
      if (instantRestarts >= MAX_INSTANT_RESTARTS) {
        close();
        sink = null;
        handlers.error("unreachable");
        return;
      }
      detach(recognition);
      launch();
    };

    session = recognition;
    startedAt = Date.now();
    try {
      recognition.start();
    } catch {
      // `start()` throws synchronously if a session is somehow already running.
      // Treat it as an ordinary end rather than a crash in a click handler.
      close();
      sink = null;
      handlers.error("unreachable");
    }
  };

  return {
    available: true,
    unavailable: "",
    open: (handlers) => {
      if (session !== null) return;
      sink = handlers;
      wanted = true;
      instantRestarts = 0;
      launch();
    },
    finalize: () => {
      // `wanted` goes false *before* `stop()`, so the `onend` it causes is read
      // as the end rather than as a silence timeout to restart. The engine
      // still delivers the pending phrase as a final first, which is the whole
      // difference between this and `abandon`.
      wanted = false;
      session?.stop();
    },
    abandon: () => {
      // `close()` detaches before this returns, so anything the browser is
      // still holding lands on a recognition object with no listeners on it.
      const current = close();
      sink = null;
      current?.abort();
    },
  };
}
