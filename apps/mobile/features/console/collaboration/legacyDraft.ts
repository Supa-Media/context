import type { EditorState } from "../files/editor";

/**
 * The draft a newly built durable controller should carry to the bucket, if
 * any, and the base it must be carried against.
 *
 * A controller that starts with no record on this device sends this through
 * the exact-base replacement. The base decides what counts as new: everything
 * in `desired` that is not in the base's revision is inserted. So it is the
 * newest revision the previous controller had acknowledged, not `etag`, which
 * only moves once nothing is pending and during continuous typing stays at the
 * version the note was opened at. Replaying against that sent the whole
 * session's typing again beside itself, once per controller rebuild
 * (2026-09-30). A draft typed before any controller existed has no
 * acknowledged revision and keeps the base it was typed against.
 */
export function legacyDraftFor(
  editor: Pick<EditorState, "draft" | "baseline" | "draftBase" | "etag" | "collaborationEtag">,
): { baseline: string; desired: string; baseEtag: string | null } | undefined {
  if (editor.draft === editor.baseline) return undefined;
  return {
    baseline: editor.baseline,
    desired: editor.draft,
    baseEtag: editor.collaborationEtag ?? editor.draftBase ?? editor.etag,
  };
}
