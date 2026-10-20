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
  /** Chrome 139+: must the words be made on this device? Absent elsewhere. */
  processLocally?: boolean;
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
/** What `SpeechRecognition.available()` answers for on-device recognition. */
export type LocalAvailability = "available" | "downloadable" | "downloading" | "unavailable";
interface LocalOptions {
  langs: string[];
  processLocally: true;
}
type SpeechRecognitionCtor = (new () => SpeechRecognitionLike) & {
  available?: (options: LocalOptions) => Promise<string>;
  install?: (options: LocalOptions) => Promise<boolean>;
};

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

/** Whether the browser says, reliably, that it has no connection. */
function knownOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  return nav?.onLine === false;
}

/**
 * How long `available()` may take before on-device is treated as absent.
 *
 * It answers from a local registry in a few milliseconds. A promise that never
 * settles would otherwise leave a capsule saying "Dictating" over a microphone
 * nobody opened, which is the failure this whole file is shaped against.
 */
const LOCAL_PROBE_MS = 1500;

/**
 * The on-device half of the Web Speech API, when this browser has a usable one.
 *
 * Chrome 139 added `processLocally` with the static `available()` and
 * `install()` beside it: the same engine, run on this machine from a language
 * pack instead of on Google's service. It is the only way a browser's dictation
 * works with no connection, and it keeps the audio on the device.
 *
 * **Never inside the desktop shell.** Electron before 42.10 has no handler for
 * the on-device interface, and calling `available()` there kills the renderer
 * outright (electron/electron#52955). The shell this repo ships is older than
 * that, so a feature check alone is not a safe answer there.
 */
function localSpeech(Recognition: SpeechRecognitionCtor) {
  const { available, install } = Recognition;
  if (typeof available !== "function" || typeof install !== "function") return null;
  const ua = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent;
  if (typeof ua === "string" && /\bElectron\//.test(ua)) return null;
  return {
    available: (lang: string): Promise<LocalAvailability> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve("unavailable"), LOCAL_PROBE_MS);
        const settle = (answer: LocalAvailability) => {
          clearTimeout(timer);
          resolve(answer);
        };
        try {
          available
            .call(Recognition, { langs: [lang], processLocally: true })
            .then(
              (answer) => settle(isLocalAvailability(answer) ? answer : "unavailable"),
              () => settle("unavailable"),
            );
        } catch {
          settle("unavailable");
        }
      }),
    /** Fire and forget: the pack is the browser's, shared by every site. */
    install: (lang: string): void => {
      try {
        void install.call(Recognition, { langs: [lang], processLocally: true }).catch(() => {});
      } catch {
        // A browser that refuses the download leaves the cloud run as it was.
      }
    },
  };
}

function isLocalAvailability(value: unknown): value is LocalAvailability {
  return (
    value === "available" ||
    value === "downloadable" ||
    value === "downloading" ||
    value === "unavailable"
  );
}

/** The language to listen for: the page's, then the browser's, then English. */
function listeningLanguage(): string {
  const scope = globalThis as {
    document?: { documentElement?: { lang?: string } };
    navigator?: { language?: unknown };
  };
  const documentLang = scope.document?.documentElement?.lang;
  if (typeof documentLang === "string" && documentLang !== "") return documentLang;
  const browserLang = scope.navigator?.language;
  if (typeof browserLang === "string" && browserLang !== "") return browserLang;
  return "en-US";
}

/**
 * The engine's own error names, in this feature's words.
 *
 * `no-speech` and `aborted` are deliberately absent: neither is a failure.
 * `no-speech` is a quiet room, and `aborted` is what our own `abandon()`
 * causes — reporting either would put a red card over somebody who simply
 * paused, or who pressed Discard.
 */
export function failureFor(error: string, offline = knownOffline()): DictationFailure | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "audio-capture":
      return "no-microphone";
    case "network":
      /*
        The engine's service could not be reached — which is NOT the same
        claim as "you are offline", and saying it was is the bug this line
        used to be. Chrome reports `network` whenever its speech service does
        not answer: a blip on Google's side, a firewall or VPN in the way, a
        Chromium build without Google's speech key (Brave, Arc, the desktop
        shell's Electron). The person in each of those is online, and telling
        them otherwise sends them to check a connection that is fine.

        So only a browser that itself says it has no connection gets the
        offline sentence. `onLine === false` is the direction of that flag
        that can be trusted (`offline/reachability.web.ts`); everything else
        is the service not answering.
      */
      return offline ? "offline" : "unreachable";
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
  /** This run makes its words on the device. Kept across silence restarts. */
  let local = false;
  /**
   * Bumped by every `open`, `finalize` and `abandon`, so an on-device probe
   * that settles after the person pressed Stop or Discard opens nothing.
   */
  let generation = 0;
  /** An `open` is waiting on the on-device probe, with no session yet. */
  let probing = false;
  const onDevice = localSpeech(Recognition);

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
    // The page's language, then the browser's. Not a stored preference:
    // somebody switching languages mid-note is rarer than somebody being
    // handed the wrong one by a setting they set once.
    recognition.lang = listeningLanguage();
    if (local) recognition.processLocally = true;

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
      if (session !== null || probing) return;
      generation += 1;
      if (onDevice === null) {
        /*
          ASKED BEFORE THE MICROPHONE OPENS, NOT AFTER IT FAILS.

          With no on-device engine, a browser that already knows it has no
          connection can only produce a live capsule, an open microphone, and
          then a `network` error a moment later. `false` from `navigator.onLine`
          is the reliable direction (`offline/reachability.web.ts`), so it is
          answered here. `true`, or no answer at all, opens exactly as before.
        */
        if (knownOffline()) {
          handlers.error("offline");
          return;
        }
        local = false;
        sink = handlers;
        wanted = true;
        instantRestarts = 0;
        launch();
        return;
      }
      /*
        ON THE DEVICE WHEN IT CAN BE, ON THE SERVICE WHEN IT CANNOT.

        A pack already installed is used every time: it works offline and the
        sound never leaves this machine. Without one, an online browser uses
        its service as it always did — and starts fetching the pack, here,
        inside the press that asked for dictation, so the next run is on the
        device and the first offline one works. Offline with no pack there is
        nothing that can make the words, and that is the one case the offline
        sentence is for.
      */
      const run = generation;
      probing = true;
      sink = handlers;
      wanted = true;
      instantRestarts = 0;
      const lang = listeningLanguage();
      void onDevice.available(lang).then((answer) => {
        if (run !== generation) return;
        probing = false;
        if (answer === "available") {
          local = true;
          launch();
          return;
        }
        if (knownOffline()) {
          wanted = false;
          sink = null;
          handlers.error("offline");
          return;
        }
        if (answer === "downloadable") onDevice.install(lang);
        local = false;
        launch();
      });
    },
    finalize: () => {
      // `wanted` goes false *before* `stop()`, so the `onend` it causes is read
      // as the end rather than as a silence timeout to restart. The engine
      // still delivers the pending phrase as a final first, which is the whole
      // difference between this and `abandon`.
      wanted = false;
      if (probing) {
        // Stop pressed before a microphone opened: nothing was heard, so the
        // run simply ends.
        generation += 1;
        probing = false;
        const handlers = sink;
        sink = null;
        handlers?.ended();
        return;
      }
      session?.stop();
    },
    abandon: () => {
      // `close()` detaches before this returns, so anything the browser is
      // still holding lands on a recognition object with no listeners on it.
      generation += 1;
      probing = false;
      const current = close();
      sink = null;
      current?.abort();
    },
  };
}
