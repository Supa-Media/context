/**
 * The Markdown a meeting becomes, as TypeScript sees it.
 *
 * `protocol.ts`'s rule, applied to the renderer: **one crossing point into
 * `@context/meetings`, and nothing is added, narrowed or renamed on the way
 * through.** The contract is not edited here, so a single import makes "did
 * somebody write a second answer to what a meeting note is" a one-file
 * question.
 *
 * Why the app needs it at all: the gateway writes the note, and on this build
 * the gateway credential is deliberately unwired (`gateway.ts`), so a meeting
 * can end up on the device with no copy anywhere else. The Copy control on
 * `MeetingNoteScreen` is what gets it out, and what it copies has to be the
 * file the customer would have had — the frontmatter naming how the meeting was
 * recorded included, because the on-bucket layout is a stable format rather
 * than an internal detail (CLAUDE.md, non-negotiable 3).
 *
 * Rendering "just the readable part" here instead would be a second renderer,
 * checked by nothing, drifting from the one in the bucket. The whole point of
 * one file per meeting is that a person can paste this into their vault and it
 * is the same note.
 */

export { renderMeetingNote } from "@context/meetings/note";
