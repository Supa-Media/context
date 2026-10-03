/**
 * The vocabulary of `activity.md`: which kinds of line exist, and what each
 * writer's action becomes. Split out of `activity.cjs`, which re-exports both
 * and holds the rules for building, merging and rendering lines.
 */

/**
 * The kinds, and what each one is for.
 *
 * A closed set, because the viewing layer draws a mark per kind and an unknown
 * kind would draw nothing. Both writers map their own vocabulary onto this —
 * the gateway's `create_note` and the console's `file.create` are one kind.
 */
const KINDS = Object.freeze([
  "added",
  "revised",
  "moved",
  "archived",
  "published",
  "meeting",
  "session",
  "remembered",
]);

/**
 * What each writer's action becomes, and what is deliberately dropped.
 *
 * `null` means "never a line". Read the nulls as the specification they are:
 *
 *  - **Reads** are not here at all, from either writer. Opening a note is not
 *    a change, and a feed that reported them would be surveillance.
 *  - **Plumbing** — `materialize_move`'s second half, the storage-layout
 *    migration, search projection, form response files — describes the
 *    product working, not somebody working.
 *  - **Arrivals on a timer** — mail, chat, calendar — are a sync job's output.
 *    They arrive by the hundred and nobody chose them.
 *  - **Proposals** are not here because they are already somewhere better: a
 *    proposal is a queue with a decision attached, and `list_proposals` is
 *    where its reviewer looks. An approved one lands as `added`.
 *  - **Key rotation and export** stay in the audit trail. They are the
 *    owner's security events, and the owner reads them where security events
 *    live rather than between two notes about a project.
 *  - **Making something private** is never a line, in either direction: the
 *    line would be the disclosure. Widening to team is, because that is an
 *    invitation to read.
 */
const SUBSTANCE = Object.freeze({
  // The gateway's vocabulary — `recordChange` in apps/mcp/src/index.js.
  create_note: "added",
  update_note: "revised",
  archive_note: "archived",
  move_note: "moved",
  move_notes: "moved",
  move_folder: "moved",
  set_visibility: "published",
  set_folder_visibility: "published",
  save_context: "session",
  // `remember`: an agent saving a fact about the person. One line per app per
  // working stretch, counting facts; the fact itself stays in the audit record
  // (docs/design/remember).
  remember_fact: "remembered",
  meeting_note: "meeting",
  approve_proposal: "added",
  propose_note: null,
  reject_proposal: null,
  materialize_move: null,
  inbox_capture: null,
  inbox_update: null,
  calendar_sync: null,
  encrypt_note: null,
  decrypt_note: null,
  rotate_encryption_keys: null,
  export_encryption_keys: null,

  // The console's vocabulary — `recordEvent` in apps/convex/functions.
  "file.create": "added",
  "file.write": "revised",
  "file.move": "moved",
  "file.archive": "archived",
  "file.copy": "added",
  "file.duplicate": "added",
  "visibility.note": "published",
  "visibility.folder": "published",
  "visibility.folder.named": "published",
  "folder.create": null,
  "file.delete": null,
  "file.decrypt": null,
  "vault.import": null,
  "vault.replace.clear": null,
});

module.exports = { KINDS, SUBSTANCE };
