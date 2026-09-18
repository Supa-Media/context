import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { DictationFailure } from "../features/voice/dictation";

/**
 * The browser half of dictation, against a fake `SpeechRecognition`.
 *
 * Three things in `engine.web.ts` are not obvious and each one has been a real
 * bug in somebody's dictation feature:
 *
 *  1. **The restart loop.** Chrome ends a session after silence; unrestarted,
 *     the microphone dies mid-pause while the capsule still says "Dictating".
 *     Restarted naively, an engine that cannot start at all becomes a hot loop
 *     opening the microphone hundreds of times a second.
 *  2. **`resultIndex` is not "one new result".** A result reported as interim
 *     can be re-reported as final in a later event, so reading only
 *     `results[resultIndex]` drops words.
 *  3. **Discard has to be deaf.** `abort()` is asynchronous in every engine, so
 *     a result already in flight can arrive after the person pressed Discard —
 *     and inserting it is text appearing in a note *after* it was refused.
 *
 * None of the three is visible in a hand test; all three are one-liners here.
 *
 * ## Sabotage record
 *
 * Applied to `features/voice/engine.web.ts`, suite run, named test observed
 * failing, reverted.
 *
 *  1. `onend` always restarts, dropping the `wanted` check.
 *     → `stopping ends the engine instead of restarting it` fails.
 *  2. `onend` never restarts.
 *     → `a session that ends after silence is restarted, because that is what
 *     silence does to Chrome` fails.
 *  3. `MAX_INSTANT_RESTARTS` raised out of reach (the hot loop).
 *     → `an engine that dies the moment it starts gives up instead of
 *     hammering the microphone` fails, after the fake counts 50 starts.
 *  4. `readResults` reads only `results[event.resultIndex]`.
 *     → `two phrases settling in one event are both kept` fails.
 *  5. `close()` returns the recognition object without detaching our
 *     callbacks from it, leaving `abort()`'s asynchrony as the only thing
 *     between a refused phrase and the note.
 *     → `a result still in flight when Discard is pressed is not delivered`
 *     fails.
 *
 *     Recorded because the first version of this file carried a second,
 *     redundant guard — a `deaf` flag — and sabotaging *that* failed nothing:
 *     `detach` was already doing the work. The flag was removed rather than
 *     given a test, on this repository's own rule that a guard nobody has
 *     checked is not a guard.
 *  6. `failureFor` maps `no-speech` to `unreachable`.
 *     → `a quiet room is not a failure` fails.
 */

interface FakeAlternative {
  transcript: string;
}
interface FakeResult {
  isFinal: boolean;
  length: number;
  [index: number]: FakeAlternative | undefined;
}

function result(transcript: string, isFinal: boolean): FakeResult {
  return { isFinal, length: 1, 0: { transcript } };
}

/** Every recognition object the engine has constructed, in order. */
let built: FakeRecognition[] = [];

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((event: { resultIndex: number; results: unknown }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;

  constructor() {
    built.push(this);
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }

  /** What the browser does: deliver results, then (later) end. */
  emit(results: FakeResult[], resultIndex = 0) {
    this.onresult?.({ resultIndex, results: { ...results, length: results.length } });
  }
  end() {
    this.onend?.();
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
}

const scope = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

function collector() {
  const finals: string[] = [];
  const interims: string[] = [];
  const errors: DictationFailure[] = [];
  let ended = 0;
  return {
    finals,
    interims,
    errors,
    get ended() {
      return ended;
    },
    handlers: {
      final: (text: string) => finals.push(text),
      interim: (text: string) => interims.push(text),
      error: (reason: DictationFailure) => errors.push(reason),
      ended: () => {
        ended += 1;
      },
    },
  };
}

/** Imported after the global is installed, so the module reads the fake. */
function load() {
  let mod!: typeof import("../features/voice/engine.web");
  jest.isolateModules(() => {
    mod = require("../features/voice/engine.web") as typeof import("../features/voice/engine.web");
  });
  return mod;
}

beforeEach(() => {
  built = [];
  scope.SpeechRecognition = FakeRecognition;
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-18T09:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
  delete scope.SpeechRecognition;
  delete scope.webkitSpeechRecognition;
});

describe("reading one result event", () => {
  test("the current guess is reported as interim, never as a phrase", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    built[0]!.emit([result("the handover is", false)]);
    expect(sink.finals).toEqual([]);
    expect(sink.interims).toEqual(["the handover is"]);
  });

  test("two phrases settling in one event are both kept", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    built[0]!.emit(
      [
        result("The handover is the blocker.", true),
        result(" No shared mailbox.", true),
        result(" follow up with", false),
      ],
      0,
    );
    expect(sink.finals).toEqual(["The handover is the blocker.", " No shared mailbox."]);
    expect(sink.interims).toEqual([" follow up with"]);
  });

  test("a settled phrase reports an empty guess, so the ghost is cleared", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    built[0]!.emit([result("The handover.", true)]);
    expect(sink.interims).toEqual([""]);
  });

  test("results before resultIndex are somebody else's news and are skipped", () => {
    const { readResults } = load();
    const results = [result("old", true), result("new", true)];
    const read = readResults({
      resultIndex: 1,
      results: { ...results, length: 2 } as never,
    });
    expect(read.finals).toEqual(["new"]);
  });
});

describe("the restart loop", () => {
  test("a session that ends after silence is restarted, because that is what silence does to Chrome", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    jest.setSystemTime(new Date("2026-09-18T09:00:30Z"));
    built[0]!.end();
    expect(built).toHaveLength(2);
    expect(built[1]!.started).toBe(1);
    expect(sink.ended).toBe(0);
  });

  test("stopping ends the engine instead of restarting it", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    const engine = createDictationEngine();
    engine.open(sink.handlers);
    engine.finalize();
    expect(built[0]!.stopped).toBe(1);
    jest.setSystemTime(new Date("2026-09-18T09:00:30Z"));
    built[0]!.end();
    expect(built).toHaveLength(1);
    expect(sink.ended).toBe(1);
  });

  test("an engine that dies the moment it starts gives up instead of hammering the microphone", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    // No clock movement at all: every session lives 0ms, the pathological case.
    for (let i = 0; i < 50 && built.length <= 10; i += 1) built.at(-1)!.end();
    expect(built.length).toBeLessThanOrEqual(3);
    expect(sink.errors).toEqual(["unreachable"]);
    expect(sink.ended).toBe(0);
  });

  test("a healthy restart clears the instant-death count", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    built.at(-1)!.end(); // instant: 1
    built.at(-1)!.end(); // instant: 2
    jest.setSystemTime(new Date("2026-09-18T09:00:30Z"));
    built.at(-1)!.end(); // lived 30s, so the count resets
    jest.setSystemTime(new Date("2026-09-18T09:01:00Z"));
    built.at(-1)!.end();
    expect(sink.errors).toEqual([]);
    expect(built.length).toBeGreaterThan(3);
  });
});

describe("failures", () => {
  test("a refused microphone is reported as denied, once, and the engine closes", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    createDictationEngine().open(sink.handlers);
    built[0]!.fail("not-allowed");
    expect(sink.errors).toEqual(["denied"]);
    built[0]!.end();
    expect(built).toHaveLength(1);
    expect(sink.ended).toBe(0);
  });

  test("a quiet room is not a failure", () => {
    const { failureFor } = load();
    expect(failureFor("no-speech")).toBeNull();
    expect(failureFor("aborted")).toBeNull();
  });

  test("the network cases are amber, not a refusal", () => {
    const { failureFor } = load();
    /*
      Chrome's engine is a Google service, so `network` means the words have
      nowhere to be made — which is a connection problem the person can act on,
      not an engine that is broken. See `offline` in `dictation.ts`.
    */
    expect(failureFor("network")).toBe("offline");
    expect(failureFor("audio-capture")).toBe("no-microphone");
    expect(failureFor("service-not-allowed")).toBe("denied");
    expect(failureFor("something-new-in-2028")).toBe("unreachable");
  });

  test("a browser that knows it is offline says so, and never opens the microphone", () => {
    /*
      The engine Chrome ships sends the audio to a server, so offline it can
      only fail — after it has opened the microphone and drawn a live capsule.
      A browser that already says it has no connection is answered before any
      of that happens, with the sentence that points at the computer's own
      dictation, which works offline.
    */
    const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { onLine: false },
    });
    try {
      const { createDictationEngine } = load();
      const sink = collector();
      createDictationEngine().open(sink.handlers);
      expect(built).toHaveLength(0);
      expect(sink.errors).toEqual(["offline"]);
    } finally {
      if (had === undefined) delete (globalThis as { navigator?: unknown }).navigator;
      else Object.defineProperty(globalThis, "navigator", had);
    }
  });

  test("a browser that is online, or will not say, opens as it always did", () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    for (const value of [{ onLine: true }, {}]) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value });
      try {
        built = [];
        const { createDictationEngine } = load();
        const sink = collector();
        createDictationEngine().open(sink.handlers);
        expect(built).toHaveLength(1);
        expect(sink.errors).toEqual([]);
      } finally {
        if (had === undefined) delete (globalThis as { navigator?: unknown }).navigator;
        else Object.defineProperty(globalThis, "navigator", had);
      }
    }
  });

  test("a browser with no engine at all says so and opens nothing", () => {
    delete scope.SpeechRecognition;
    delete scope.webkitSpeechRecognition;
    const { createDictationEngine, NO_ENGINE } = load();
    const engine = createDictationEngine();
    const sink = collector();
    expect(engine.available).toBe(false);
    expect(engine.unavailable).toBe(NO_ENGINE);
    engine.open(sink.handlers);
    expect(built).toEqual([]);
    expect(sink.errors).toEqual(["unsupported"]);
  });

  test("the prefixed constructor is used where the bare one is missing", () => {
    delete scope.SpeechRecognition;
    scope.webkitSpeechRecognition = FakeRecognition;
    const { createDictationEngine } = load();
    expect(createDictationEngine().available).toBe(true);
  });
});

describe("discarding", () => {
  test("a result still in flight when Discard is pressed is not delivered", () => {
    const { createDictationEngine } = load();
    const sink = collector();
    const engine = createDictationEngine();
    engine.open(sink.handlers);
    const live = built[0]!;
    engine.abandon();
    live.emit([result("words nobody asked to keep", true)]);
    expect(sink.finals).toEqual([]);
    expect(live.aborted).toBe(1);
    expect(live.stopped).toBe(0);
  });

  test("discard never asks the engine to settle what it heard", () => {
    const { createDictationEngine } = load();
    const engine = createDictationEngine();
    engine.open(collector().handlers);
    engine.abandon();
    expect(built[0]!.stopped).toBe(0);
  });

  test("the engine is configured for continuous, interim-bearing recognition", () => {
    const { createDictationEngine } = load();
    createDictationEngine().open(collector().handlers);
    expect(built[0]!.continuous).toBe(true);
    expect(built[0]!.interimResults).toBe(true);
  });

  test("opening twice does not open a second microphone", () => {
    const { createDictationEngine } = load();
    const engine = createDictationEngine();
    engine.open(collector().handlers);
    engine.open(collector().handlers);
    expect(built).toHaveLength(1);
  });
});
