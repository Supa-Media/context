import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the screens are allowed to say.
 *
 * Every assertion here is about a **claim**, not a layout. This repo has
 * shipped invented facts about somebody's own storage twice (#20 and #25), and
 * the rule that came out of it is the one these tests enforce: where there is
 * no answer, a screen renders nothing rather than something plausible, and
 * "saved" is said only when there is a path in the customer's bucket to print.
 *
 * The screens run against the **real controller** with a memory store, a fake
 * gateway and a fake recorder, so what is being checked is the whole path from
 * a press to the words on the glass — not a component fed a hand-made prop that
 * happens to be in the state the test wanted.
 *
 * The last block is the web-target honesty check: the browser build must
 * degrade to a typed-notes-only session and say so, rather than crashing on a
 * capability it does not have or drawing a transcript chip over silence.
 *
 * ## Why `pushed`/`mockPathname` and the two `jest.mock`s are not here
 *
 * Every file in this folder needs its own `jest.mock("expo-router", ...)` —
 * jest.mock is hoisted per file, not shared through an import — and that
 * factory reads `pushed`/`mockPathname` as plain locals the way the original
 * single file did. Routing them through this module instead would nest a
 * `require("./fixtures")` still in flight inside the mock factory it
 * registers, the same circularity `meetingsCapture/fixtures.ts` documents for
 * `audio.ts`. So each file declares its own, right before its own two
 * `jest.mock`s.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export const { MeetingsListScreen } =
  require("../../features/meetings/MeetingsListScreen") as typeof import("../../features/meetings/MeetingsListScreen");
export const { LiveMeetingScreen } =
  require("../../features/meetings/LiveMeetingScreen") as typeof import("../../features/meetings/LiveMeetingScreen");
export const { MeetingNoteScreen } =
  require("../../features/meetings/MeetingNoteScreen") as typeof import("../../features/meetings/MeetingNoteScreen");
export const { RecordingBar } =
  require("../../features/meetings/components/RecordingBar") as typeof import("../../features/meetings/components/RecordingBar");
export const { meetings } =
  require("../../features/meetings/controller") as typeof import("../../features/meetings/controller");
export const { fakeGateway } =
  require("../../features/meetings/fakeGateway") as typeof import("../../features/meetings/fakeGateway");
export const { fakeRecorder, fakeSegment } =
  require("../../features/meetings/capture/fake") as typeof import("../../features/meetings/capture/fake");
export const { notesOnlyRecorder } =
  require("../../features/meetings/capture") as typeof import("../../features/meetings/capture");
export const { memoryStore } =
  require("../../features/offline/memory") as typeof import("../../features/offline/memory");
export const { meetingKey } =
  require("../../features/meetings/keys") as typeof import("../../features/meetings/keys");
export const { MEETING_RECORD_VERSION, emptyAck, pendingSteps } =
  require("../../features/meetings/record") as typeof import("../../features/meetings/record");
export const { FINALIZE_TIMEOUT_MS } =
  require("../../features/meetings/recovery") as typeof import("../../features/meetings/recovery");
export const { saveMeeting } =
  require("../../features/meetings/local") as typeof import("../../features/meetings/local");
export const { seedSession } =
  require("../../features/meetings/session") as typeof import("../../features/meetings/session");
export const { continuationFromRecord } =
  require("../../features/meetings/resume") as typeof import("../../features/meetings/resume");
export const { PROTOCOL_VERSION: MEETING_PROTOCOL_VERSION } =
  require("../../features/meetings/protocol") as typeof import("../../features/meetings/protocol");
export const { currentEpoch } =
  require("../../features/offline/epoch") as typeof import("../../features/offline/epoch");
/* eslint-enable @typescript-eslint/no-require-imports */

/* -------------------------------------------------------------------------- */

export interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

export function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    container: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

export function press(container: HTMLElement, testId: string): void {
  const target = container.querySelector(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`no control named ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function has(container: HTMLElement, testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null;
}

/**
 * Type into a field the way a browser does: set the value through the
 * prototype's own setter, then fire `input`.
 *
 * The setter matters. React installs its own `value` descriptor on the element,
 * so assigning `el.value` directly leaves React's tracker believing nothing
 * changed and the `input` event is swallowed — the test then passes against a
 * screen wired to nothing. `meetingsTyping.test.ts` carries the same helper for
 * the notepad; this one takes either tag, because a title is an `<input>` and
 * notes are a `<textarea>`.
 */
export function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype =
    field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * A destination the way the sheet supplies one, so a record has the *context*
 * half of a note's address.
 *
 * `controller.start` leaves it `null` when nobody was asked — the meetings
 * list's one-tap record genuinely chose nothing — and a record with no context
 * cannot be turned into a console URL without guessing which workspace. So a test
 * about the link supplies one, and the test about the absence does not.
 */
export const RECORDED_INTO = {
  kind: "personalInbox",
  contextSlug: "seyi",
  folder: "0-inbox/meetings",
} as const;

/** The one control named `testId`, as the element it actually is. */
export function field<T extends HTMLElement>(container: HTMLElement, testId: string): T {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`no control named ${testId}`);
  return found as T;
}

export async function configure(
  options: {
    recorder?: ReturnType<typeof fakeRecorder> | ReturnType<typeof notesOnlyRecorder>;
    /** A folder this run's gateway will not file into. Drives the fallback. */
    refusesFolder?: (folder: string) => boolean;
  } = {},
) {
  const gateway = fakeGateway({ refusesFolder: options.refusesFolder });
  const recorder = options.recorder ?? fakeRecorder();
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: `ws-${Math.random().toString(36).slice(2)}`,
      store: memoryStore(),
      gateway,
      recorder,
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
  return { gateway, recorder };
}
