import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { setNoteProperty } from "../../mcp/src/lists.js";
import { createCastClock } from "../features/home/cast/castClock";
import { CAST_MOMENTS, playCast, type CastMoment } from "../features/home/cast/castRun";
import { castTimeline } from "../features/home/cast/castTimeline";
import { asStageEvent, stageEvent } from "../features/home/cast/studioLink";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import {
  DEFAULT_VOLUME,
  MOMENT_SOUNDS,
  SOUNDS_PROPERTY,
  defaultPlan,
  momentCount,
  soundItems,
  soundLabel,
  soundPlan,
} from "../features/studio/sounds/castSounds";
import { createSoundPlayer, TYPING_GAP_MS } from "../features/studio/sounds/soundPlayer";
import { BUILT_IN_SOUNDS, soundLength } from "../features/studio/sounds/synth";

const SCENE = [
  "# Pricing",
  "",
  "Free is free, you cheapo.",
  "",
  "```cast",
  "@maya types: hi.",
  "@maya's Codex comments on \"you cheapo\": a little unprofessional?",
  "@jon replies: eh",
  "@jon resolves",
  "Claude adds note: tour",
  "  # Tour",
  "```",
  "",
].join("\n");

describe("a scene's sounds, kept in its note", () => {
  test("a note that says nothing plays the defaults, and writes nothing back", () => {
    const plan = soundPlan(SCENE);
    expect(plan).toEqual(defaultPlan());
    expect(soundItems(plan)).toBeNull();
    for (const moment of CAST_MOMENTS) expect(plan.moments[moment].volume).toBe(DEFAULT_VOLUME);
  });

  test("what the studio chooses is what the note reads back, through the Properties panel's own write", () => {
    const plan = defaultPlan();
    plan.moments.comment = { sound: "bell", volume: 70 };
    plan.moments.typing = { sound: "off", volume: DEFAULT_VOLUME };
    plan.on = false;
    const items = soundItems(plan);
    expect(items).toEqual(["typing off", "comment bell 70%", "all off"]);
    const written = setNoteProperty(`---\ntitle: Pricing\n---\n${SCENE}`, SOUNDS_PROPERTY, items);
    expect("error" in written).toBe(false);
    const text = (written as { text: string }).text;
    expect(text).toContain("sounds: [typing off, comment bell 70%, all off]");
    expect(soundPlan(text)).toEqual(plan);
    // Back to the defaults takes the line away again.
    const cleared = setNoteProperty(text, SOUNDS_PROPERTY, soundItems(defaultPlan())) as { text: string };
    expect(cleared.text).not.toContain("sounds:");
  });

  test("a line it cannot read is ignored, never refused", () => {
    const note = "---\nsounds: [comment nope, bogus bell, typing off, comment bell 150%, JOIN Doorbell, all maybe]\n---\n# x\n";
    const plan = soundPlan(note);
    expect(plan.on).toBe(true);
    expect(plan.moments.typing.sound).toBe("off");
    expect(plan.moments.comment).toEqual({ sound: "bell", volume: 100 });
    expect(plan.moments.join.sound).toBe("doorbell");
    expect(soundPlan("---\nsounds: chime\n---\n").moments).toEqual(defaultPlan().moments);
  });

  test("an uploaded sound is named by its stored file, and read back as one", () => {
    const leaf = "sound-0123456789abcdef.wav";
    const plan = defaultPlan();
    plan.moments.agent = { sound: leaf, volume: 60 };
    const items = soundItems(plan);
    expect(items).toEqual([`agent ${leaf} 60%`]);
    const text = (setNoteProperty("# x\n", SOUNDS_PROPERTY, items) as { text: string }).text;
    expect(soundPlan(text).moments.agent).toEqual({ sound: leaf, volume: 60 });
    expect(soundLabel(leaf)).toBe("Your sound");
    // Anything else shaped like a file is not a sound the studio will ask for.
    for (const other of ["sound-0123.wav", "sound-0123456789abcdef.svg", "paste-0123456789abcdef.png", "../privacy.md"]) {
      expect(soundPlan(`---\nsounds: [agent ${other}]\n---\n`).moments.agent.sound).toBe("pop");
    }
  });

  test("counts read in words", () => {
    expect(momentCount(0)).toBe("not in this scene");
    expect(momentCount(1)).toBe("1 time");
    expect(momentCount(3)).toBe("3 times");
  });
});

describe("the built-in set", () => {
  test("every moment offers five sounds that exist, and every sound is short and under full scale", () => {
    for (const moment of CAST_MOMENTS) {
      const offered = MOMENT_SOUNDS[moment];
      expect(new Set(offered).size).toBe(5);
      for (const id of offered) expect(id in BUILT_IN_SOUNDS).toBe(true);
    }
    for (const sound of Object.values(BUILT_IN_SOUNDS)) {
      expect(soundLength(sound)).toBeLessThanOrEqual(1);
      for (const voice of sound.voices) {
        expect(voice.gain).toBeGreaterThan(0);
        expect(voice.gain).toBeLessThanOrEqual(1);
        expect(voice.dur).toBeGreaterThan(0);
      }
    }
  });
});

describe("a show's moments", () => {
  test("the show says each moment as it happens", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    const clock = createCastClock();
    const shared = createSharedDoc({});
    seedSharedDoc(shared, markdown);
    const cues: CastMoment[] = [];
    playCast(steps, shared, {
      schedule: (ms, run) => clock.schedule(ms, run),
      instant: () => false,
      pageNamed: () => null,
      addNote: (name) => `${name}.md`,
      agentDid: () => {},
      room: () => {},
      cue: (moment) => cues.push(moment),
    });
    clock.rush(() => false);
    const collapsed = cues.filter((moment, index) => moment !== "typing" || cues[index - 1] !== "typing");
    expect(collapsed).toEqual(["join", "typing", "agent", "comment", "join", "typing", "comment", "resolve", "note"]);
    expect(cues.filter((moment) => moment === "typing")).toHaveLength("hi.".length + "eh".length);
    clock.stop();
  });

  test("the studio counts them, typing once a line", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    expect(castTimeline(markdown, steps).moments).toEqual({
      join: 2,
      agent: 1,
      typing: 2,
      writes: 0,
      click: 0,
      comment: 2,
      resolve: 1,
      note: 1,
      error: 0,
    });
  });

  test("an assistant giving up (a usage limit, an overload) is an error, not words landing", () => {
    const cuesOf = (lines: string[]) => {
      const { steps } = splitWebsiteCast(["# x", "", "```cast", ...lines, "```", ""].join("\n"));
      const clock = createCastClock();
      const cues: CastMoment[] = [];
      playCast(steps, createSharedDoc({}), {
        schedule: (ms, run) => clock.schedule(ms, run),
        instant: () => false,
        pageNamed: () => null,
        addNote: (name) => `${name}.md`,
        agentDid: () => {},
        room: () => {},
        cue: (moment) => cues.push(moment),
      });
      clock.rush(() => false);
      clock.stop();
      return cues.filter((moment) => moment === "writes" || moment === "error");
    };
    expect(cuesOf(["Claude answers: Weekly usage limit reached."])).toEqual(["error"]);
    expect(cuesOf(["Claude Code answers: Claude usage limit reached. Resets Monday 9am."])).toEqual(["error"]);
    expect(cuesOf(["ChatGPT says: Error: overloaded. Try again later."])).toEqual(["error"]);
    expect(cuesOf(["Codex answers: You've hit your rate limit."])).toEqual(["error"]);
    // Talking about an error is still an answer.
    expect(cuesOf(["Claude answers: Fixed the error in refunds.ts. The limit check reads the event id now."])).toEqual(["writes"]);
    expect(cuesOf(["Claude answers: Error handling lives in one place now."])).toEqual(["writes"]);
  });

  test("a cue crosses to the studio only as a moment it knows", () => {
    expect(asStageEvent(stageEvent({ kind: "cue", moment: "comment" }))).toEqual(stageEvent({ kind: "cue", moment: "comment" }));
    expect(asStageEvent({ tag: "context-cast-studio", kind: "cue", moment: "explode" })).toBeNull();
    expect(asStageEvent({ tag: "context-cast-studio", kind: "cue" })).toBeNull();
  });
});

describe("the sound player", () => {
  function fakeAudio() {
    const started: string[] = [];
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = () => ({ connect() {}, gain: param() });
    class FakeContext {
      state = "running";
      currentTime = 0;
      sampleRate = 8000;
      destination = {};
      createGain() {
        return node();
      }
      createOscillator() {
        return { ...node(), type: "", frequency: param(), start: () => started.push("tone"), stop() {} };
      }
      createBufferSource() {
        return { ...node(), buffer: null, start: () => started.push("noise"), stop() {} };
      }
      createBiquadFilter() {
        return { ...node(), type: "", Q: param(), frequency: param() };
      }
      createBuffer(_channels: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    return { audio: FakeContext as unknown as new () => AudioContext, started };
  }

  test("plays a recipe's voices, keeps quiet for Off, silence and names it does not know", () => {
    const { audio, started } = fakeAudio();
    const player = createSoundPlayer(audio, () => 0);
    player.play("chime", 80);
    expect(started).toEqual(["tone", "tone"]);
    player.play("off", 80);
    player.play("nope", 80);
    player.play("chime", 0);
    expect(started).toHaveLength(2);
  });

  test("keys closer together than a patter make one sound", () => {
    const { audio, started } = fakeAudio();
    let now = 1_000;
    const player = createSoundPlayer(audio, () => now);
    player.play("keys", 80, { typing: true });
    now += TYPING_GAP_MS - 1;
    player.play("keys", 80, { typing: true });
    expect(started).toHaveLength(1);
    now += 1;
    player.play("keys", 80, { typing: true });
    expect(started).toHaveLength(2);
  });

  /** A fake context that records what each gain and the export's delay connect to. */
  function tappedAudio() {
    const { audio } = fakeAudio();
    const tap = { stream: { id: "tap" } };
    const fake = audio as unknown as { prototype: Record<string, unknown> };
    fake.prototype.createMediaStreamDestination = () => tap;
    const connected: unknown[] = [];
    const delays: { delayTime: { value: number }; to: unknown[]; max: number }[] = [];
    fake.prototype.createDelay = (max: number) => {
      const delay = { delayTime: { value: 0 }, to: [] as unknown[], max, connect: (to: unknown) => delay.to.push(to) };
      delays.push(delay);
      return delay;
    };
    const base = (audio as unknown as { prototype: { createGain: () => { connect: (to: unknown) => void } } }).prototype.createGain;
    fake.prototype.createGain = function (this: unknown) {
      const gain = base.call(this);
      return { ...gain, connect: (to: unknown) => connected.push(to) };
    };
    return { audio, tap, connected, delays };
  }

  test("an export hears every sound the studio plays from then on", () => {
    const { audio, tap, connected, delays } = tappedAudio();
    const player = createSoundPlayer(audio, () => 0);
    player.play("chime", 80);
    expect(delays).toHaveLength(0);
    const stream = player.capture();
    expect(stream).toBe(tap.stream);
    // The take's sound goes through one delay into the stream.
    expect(delays).toHaveLength(1);
    expect(delays[0].to).toEqual([tap]);
    player.play("chime", 80);
    expect(connected).toContain(delays[0]);
    expect(connected).not.toContain(tap);
    // Released: the next sound goes to the speakers only.
    player.release();
    connected.length = 0;
    player.play("chime", 80);
    expect(connected).not.toContain(delays[0]);
  });

  test("the file's sound waits for the picture, and the speakers never do", () => {
    // "the audio seems out of sync with the video export" (Dev2, 2026-10-01):
    // the picture reaches the file after a trip through tab sharing, the
    // sound straight from here, so the file's sound is held back to match.
    const { audio, connected, delays } = tappedAudio();
    const player = createSoundPlayer(audio, () => 0);
    player.capture();
    player.lag(0.12);
    expect(delays[0].delayTime.value).toBeCloseTo(0.12);
    player.play("chime", 80);
    // Heard live with no delay: the speakers are wired straight on.
    expect(connected).toContain(delays[0]);
    expect(connected.some((to) => to !== delays[0])).toBe(true);
    // A nonsense reading never pushes the sound out of reach.
    player.lag(-1);
    expect(delays[0].delayTime.value).toBe(0);
    player.lag(Number.NaN);
    expect(delays[0].delayTime.value).toBe(0);
    player.lag(9);
    expect(delays[0].delayTime.value).toBeLessThanOrEqual(delays[0].max);
  });

  test("a lag set before capture, or after release, does nothing and throws nothing", () => {
    const { audio, delays } = tappedAudio();
    const player = createSoundPlayer(audio, () => 0);
    expect(() => player.lag(0.1)).not.toThrow();
    player.capture();
    expect(delays[0].delayTime.value).toBe(0);
    player.release();
    expect(() => player.lag(0.1)).not.toThrow();
  });

  test("with no Web Audio, an export is silent rather than broken", () => {
    const player = createSoundPlayer(undefined);
    expect(player.capture()).toBeNull();
    expect(() => player.lag(0.1)).not.toThrow();
    expect(() => player.release()).not.toThrow();
  });

  test("with no Web Audio, nothing happens and nothing throws", () => {
    const player = createSoundPlayer(undefined);
    expect(() => player.play("chime", 80)).not.toThrow();
    player.close();
  });
});
