/**
 * Is something else already listening?
 *
 * The strongest single signal there is. A conferencing app that is *running* is
 * weak evidence — Zoom sits in the menu bar all day — but a conferencing app
 * that is *holding an input device* is a call in progress, which is why
 * `DetectionSignals.microphoneInUse` exists as its own field.
 *
 * ## What this implementation actually knows, and what it does not
 *
 * `ioreg` reports the state of IOAudioEngine objects, which is a real answer on
 * Intel Macs and on any machine with a USB or Thunderbolt interface: an engine
 * in state 1 is running. On Apple Silicon the built-in microphone does not
 * publish an IOAudioEngine at all, so the class can be **absent** — and absent
 * is not "no". This collector therefore distinguishes the two:
 *
 *  - engines present, none running → `false`, a real negative;
 *  - engines present, one running → `true`;
 *  - **no engines at all → throws**, so the loop records the collector as
 *    degraded rather than reporting a confident "nobody is on a call".
 *
 * The honest fix is a small native addon reading CoreAudio's
 * `kAudioDevicePropertyDeviceIsRunningSomewhere`, which is the API this
 * question actually has. It is listed in `README.md` under "what is stubbed";
 * this is what can be done from a shell without one, and it says so.
 */

import { run } from "../exec.ts";

export interface EngineReading {
  engines: number;
  running: number;
}

/** Count `"IOAudioEngineState" = N` lines. Exported so the suite uses fixtures. */
export function parseEngineState(stdout: string): EngineReading {
  const matches = [...stdout.matchAll(/"IOAudioEngineState"\s*=\s*(\d+)/g)];
  return {
    engines: matches.length,
    running: matches.filter((match) => match[1] !== "0").length,
  };
}

export function readingToSignal(reading: EngineReading): boolean {
  if (reading.engines === 0) {
    throw new Error("no audio engines are visible to ioreg on this machine");
  }
  return reading.running > 0;
}

export async function collectMicrophoneInUse(): Promise<boolean> {
  const stdout = await run("/usr/sbin/ioreg", ["-c", "IOAudioEngine", "-r", "-w", "0"], {
    timeoutMs: 3_000,
  });
  return readingToSignal(parseEngineState(stdout));
}
