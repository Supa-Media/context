import { BUILT_IN_SOUNDS, type BuiltInSound, type Voice } from "./synth";

/** Keys closer together than this make one sound: typing is a patter, not a buzz. */
export const TYPING_GAP_MS = 55;

/** The loudest a sound plays at 100%, so a scene's sounds sit under its pictures. */
const HEADROOM = 0.6;

export interface SoundPlayer {
  /** Play a built-in sound at `volume` percent. `"off"` and unknown ids are silent. */
  play: (id: string, volume: number, options?: { typing?: boolean }) => void;
  /** An uploaded sound's bytes, made ready to play; `null` when the browser cannot read them. */
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer | null>;
  /** Play a decoded upload at `volume` percent. */
  playBuffer: (buffer: AudioBuffer, volume: number, options?: { typing?: boolean }) => void;
  /**
   * Make the audio context now, inside a press. Safari lets a page make a
   * sound only once one was made or resumed during a press, and a cue arrives
   * from the stage, never during one.
   */
  wake: () => void;
  close: () => void;
}

type AudioContextClass = new () => AudioContext;

/**
 * Plays `synth.ts`'s recipes with Web Audio.
 *
 * The audio context is made by `wake`, from a press in the studio, or else on
 * the first sound. Cues arrive from the stage rather than during a press, so
 * a browser as strict as Safari needs the `wake`.
 * Where there is no Web Audio at all (a phone's runtime, a test) it is silent.
 */
export function createSoundPlayer(
  audio: AudioContextClass | undefined = (globalThis as { AudioContext?: AudioContextClass }).AudioContext,
  now: () => number = () => Date.now(),
): SoundPlayer {
  let context: AudioContext | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let lastKey = -Infinity;

  const ready = (): AudioContext | null => {
    if (audio === undefined) return null;
    if (context === null) context = new audio();
    if (context.state === "suspended") void context.resume();
    return context;
  };

  const noise = (ctx: AudioContext) => {
    if (noiseBuffer === null) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  };

  const voice = (ctx: AudioContext, out: AudioNode, one: Voice, start: number) => {
    const at = start + one.at;
    const end = at + one.dur;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, one.gain), at + Math.min(0.006, one.dur / 4));
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    envelope.connect(out);
    if (one.kind === "tone") {
      const osc = ctx.createOscillator();
      osc.type = one.wave;
      osc.frequency.setValueAtTime(one.hz, at);
      if (one.to !== undefined) osc.frequency.exponentialRampToValueAtTime(one.to, end);
      osc.connect(envelope);
      osc.start(at);
      osc.stop(end + 0.02);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = noise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = one.q;
    filter.frequency.setValueAtTime(one.hz, at);
    if (one.to !== undefined) filter.frequency.exponentialRampToValueAtTime(one.to, end);
    source.connect(filter);
    filter.connect(envelope);
    source.start(at);
    source.stop(end + 0.02);
  };

  /** The output at `volume`, or `null` for silence (Off, a key too soon, no Web Audio). */
  const output = (volume: number, typing: boolean): { ctx: AudioContext; level: GainNode } | null => {
    if (volume <= 0) return null;
    if (typing) {
      const t = now();
      if (t - lastKey < TYPING_GAP_MS) return null;
      lastKey = t;
    }
    const ctx = ready();
    if (ctx === null) return null;
    const level = ctx.createGain();
    level.gain.value = (Math.min(100, volume) / 100) * HEADROOM;
    level.connect(ctx.destination);
    return { ctx, level };
  };

  return {
    play(id, volume, options) {
      const sound = (BUILT_IN_SOUNDS as Record<string, BuiltInSound | undefined>)[id];
      if (sound === undefined) return;
      const out = output(volume, options?.typing === true);
      if (out === null) return;
      for (const one of sound.voices) voice(out.ctx, out.level, one, out.ctx.currentTime + 0.005);
    },
    async decode(bytes) {
      const ctx = ready();
      if (ctx === null) return null;
      try {
        // A copy: decoding detaches the buffer it is handed.
        return await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        return null;
      }
    },
    playBuffer(buffer, volume, options) {
      const out = output(volume, options?.typing === true);
      if (out === null) return;
      const source = out.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out.level);
      source.start(out.ctx.currentTime + 0.005);
    },
    wake() {
      ready();
    },
    close() {
      void context?.close();
      context = null;
      noiseBuffer = null;
    },
  };
}
