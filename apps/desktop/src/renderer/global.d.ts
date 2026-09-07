/**
 * What the preloads put on `window`, declared once.
 *
 * Two surfaces, and the difference between them is the point: `window.context`
 * is what the panel and the notepad get — render state, send verbs — and
 * `window.capture` is what the hidden capture window gets, which is four
 * lifecycle callbacks and a way to hand a chunk back. Neither can read a
 * credential, reach the filesystem, or run a collector.
 *
 * A `.d.ts` rather than a `declare global` inside each renderer, because two
 * modules augmenting `Window` with the same property is a merge waiting to
 * disagree with itself.
 */

import type { UiState } from "../main/ipc.ts";

declare global {
  interface Window {
    context: {
      onState(handler: (state: UiState) => void): void;
      accept(episode: string): void;
      record(): void;
      decline(episode: string): void;
      pause(): void;
      resume(): void;
      end(): void;
      notes(markdown: string): void;
      title(title: string): void;
      setAskBeforeEveryMeeting(value: boolean): void;
      setBlocklist(list: string[]): void;
      connect(): void;
      disconnect(): void;
    };
    capture: {
      onStart(handler: (options: { channels: ("mic" | "system")[]; sampleRate: number }) => void): void;
      onPause(handler: () => void): void;
      onResume(handler: () => void): void;
      onStop(handler: () => void): void;
      /** Capture is running. `degraded` names the channels macOS would not give. */
      ready(degraded: string[]): void;
      failed(message: string): void;
      /** One complete, self-contained audio file. Never a timeslice fragment. */
      chunk(chunk: {
        channel: "mic" | "system";
        atMs: number;
        durationMs: number;
        mimeType: string;
        data: Uint8Array;
      }): void;
    };
  }
}
