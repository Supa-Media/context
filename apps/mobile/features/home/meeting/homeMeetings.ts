import { ConvexError } from "convex/values";
import type { MeetingDestination } from "../../meetings/destination";
import { createConvexGateway } from "../../meetings/convexGateway";
import type { MeetingsGateway } from "../../meetings/gateway";

/**
 * The homepage's meetings, as pure pieces: where a demo meeting lands, how
 * long it may run, and the writer that puts it into the visitor's tab.
 *
 * The owner's ask (2026-09-28): a visitor to context.lc can record a meeting
 * to try it, and the first one makes an `inbox/meetings` folder. So the
 * homepage points the app's one meetings controller at a writer whose bucket
 * is the tab — the notes `useLocalFileBrowser` keeps, gone on reload like
 * every other visitor edit — and everything a visitor sees while recording is
 * the console's own panel, recorder and note. Nothing here draws.
 */

/** The device key the homepage's meetings are kept under, in memory only. */
export const HOME_MEETINGS_WORKSPACE = "home";

/**
 * Where a visitor's meeting goes: `inbox/meetings` in the homepage's workspace.
 *
 * Not `0-inbox/meetings`, the default in a real context: the homepage's tree is
 * the website folder, which has no PARA numbers, and the owner named the folder
 * `inbox/meetings`. It does not exist until the first meeting is written.
 */
export const HOME_MEETINGS_FOLDER = "inbox/meetings";

export function homeMeetingDestination(contextSlug: string): MeetingDestination {
  return { kind: "personalInbox", contextSlug, folder: HOME_MEETINGS_FOLDER };
}

/**
 * How long a demo meeting runs before it stops itself.
 *
 * The same number as `DEMO_MEETING_MS` in
 * `apps/convex/functions/meetings/demoTranscribe.ts`, which refuses audio past
 * it: that one is the bound, this one is the courtesy of stopping cleanly at
 * it rather than recording words nobody will transcribe.
 */
export const HOME_MEETING_MS = 2 * 60_000;

/** Said when a demo meeting reaches its length and stops. */
export const HOME_MEETING_STOPPED =
  "Demo meetings stop at two minutes. Your notes and transcript are in inbox/meetings.";

/**
 * The writer: the ordinary meeting writer, over the tab's notes.
 *
 * `createConvexGateway` is the writer the signed-in app uses, and it is reused
 * whole rather than copied: the note is rendered by the same `note.ts`, filed
 * at the same `meetingNotePath`, and a retry is caught the same way — a
 * create-only write that answers `CONFLICT` when the note is already there.
 * `put` is that create-only write against the tab. No `readNote`, so the
 * writer says it cannot continue a note and nothing offers Resume.
 */
export function homeMeetingsGateway(put: (path: string, text: string) => boolean): MeetingsGateway {
  return createConvexGateway({
    writeNote: async ({ path, text }) => {
      if (!put(path, text)) {
        throw new ConvexError({ code: "CONFLICT", message: "That meeting is already in this tab." });
      }
      return { path };
    },
    resolveWorkspaceId: () => HOME_MEETINGS_WORKSPACE,
  });
}

/** A random id for this tab, which the demo transcription budget is kept by. */
export function newVisitorId(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  return Array.from(random(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
