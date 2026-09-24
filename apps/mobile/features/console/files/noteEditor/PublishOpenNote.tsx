import { useEffect } from "react";
import { publishOpenNote } from "../../../agent/openNote";
import { agentPage } from "../../../agent/page";
import type { EditorState } from "../editor";

/**
 * Publish what is open, and clear it on the way out.
 *
 * A component rather than an effect inside `NoteEditor` for one reason: it
 * unmounts when the pane does, and its cleanup is what stops a stale note
 * being published after the editor has gone — which would leave the console's
 * right panel describing a room nobody is in.
 *
 * It renders nothing. `agentPage` is asked for the reference rather than
 * `noteReference` directly, because that function is private to `page.ts` and
 * deliberately so: the editor's state is the only thing it accepts, and this
 * is the editor.
 */
export function PublishOpenNote({ state }: { state: EditorState }) {
  const reference = agentPage({
    context: null,
    editor: state,
    route: "",
    meetingLive: false,
    query: null,
  }).note;

  useEffect(() => {
    publishOpenNote(reference);
  }, [reference]);

  useEffect(() => () => publishOpenNote(null), []);

  return null;
}
