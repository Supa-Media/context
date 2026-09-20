import { noteHref } from "../console/nav";
import type { MeetingRecord } from "./record";

/**
 * The console's own file page for this meeting's note, or `null`.
 *
 * Two facts and both come from somewhere that already knows them: the **path**
 * is the gateway's answer and is the only thing that says where a note is, and
 * the **context** is the destination the recording was started with — the one
 * this device pointed the finalize at. Neither is guessed.
 *
 * `null` where either is missing, which is not a defensive default but the two
 * real cases: a meeting that has not been written yet has no path, and a record
 * from a build before `MeetingRecord.destination` existed has no slug. A link
 * built on a guessed context would open the right path in the wrong workspace, and
 * the address bar would not say so.
 *
 * ## Its own module, and that is not tidiness
 *
 * It lived in `MeetingNoteScreen`, which imports `expo-router` — so the console
 * panel asking this one question pulled a navigator into its module graph and
 * the panel's own tests could not load at all. `route.ts` states the rule this
 * follows: a fact a caller needs about meetings lives where it can be imported
 * without the screens around it. Nothing here renders, and nothing routes.
 */
export function noteEditorHref(record: MeetingRecord): string | null {
  const slug = record.destination?.contextSlug ?? null;
  const path = record.session.notePath;
  if (slug === null || path === null) return null;
  return noteHref(slug, path);
}
