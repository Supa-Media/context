/**
 * The Markdown a meeting becomes, as TypeScript sees it.
 *
 * `protocol.ts`'s rule, applied to the renderer: **one crossing point into
 * `@context/meetings`, and nothing is added, narrowed or renamed on the way
 * through.** The contract is not edited here, so a single import makes "did
 * somebody write a second answer to what a meeting note is" a one-file
 * question.
 *
 * Why the app needs it at all, and it is no longer the reason first written
 * here. This module arrived while the app could not reach the bucket at all, so
 * Copy was the only way a meeting got off the device. That is fixed —
 * `convexGateway.ts` writes the note through `files.writeNote` — and the app
 * needs the renderer *more* rather than less, because it is now the thing
 * composing the file. Copy is the way out for a meeting the queue has not
 * landed yet: offline, a bucket that is not connected, a refusal parked for a
 * person. What it copies has to be the file the customer would have had — the frontmatter naming how the meeting was
 * recorded included, because the on-bucket layout is a stable format rather
 * than an internal detail (CLAUDE.md, non-negotiable 3).
 *
 * Rendering "just the readable part" here instead would be a second renderer,
 * checked by nothing, drifting from the one in the bucket. The whole point of
 * one file per meeting is that a person can paste this into their vault and it
 * is the same note.
 */

export { renderMeetingNote } from "@context/meetings/note";
