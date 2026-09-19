import { createContext, useContext, type ReactNode } from "react";
import type { AgentEngine } from "../agent/engine";
import type { VoicePage } from "./VoiceButton";

/**
 * What the console knows and the note editor does not.
 *
 * `NoteEditor` holds the one thing the microphone needs that nothing else has —
 * the live `EditorControls` — and knows nothing about contexts, membership or
 * meetings. The console layout knows all three and holds `useMeetingFlow`. So
 * the button is mounted where the editor is and fed from where the console is,
 * over a context rather than through `BrowsePane`'s props.
 *
 * ## It is nullable, and that is what keeps three other surfaces unchanged
 *
 * `BrowsePane` is rendered by the landing page's demo console, by the E2E
 * fixture and by the visual fixture as well as by the real console. None of
 * those has a workspace, a membership or a microphone worth offering, and none
 * of them provides this. `useVoiceHost()` answers `null` there and the editor
 * draws no button — rather than each of those surfaces having to pass a prop
 * saying "not here".
 */

export interface VoiceHost {
  page: VoicePage;
  /** Opens the meeting's own destination sheet. See `VoiceSheet`. */
  onRecordMeeting: () => void;
  /**
   * What answers a question, or absent for a surface with nothing behind it.
   *
   * It rides here for the reason everything else on this object does: the
   * engine needs the workspace id and the MCP endpoint, which the console
   * layout holds and `NoteEditor` has never seen. Absent on the demo console,
   * the E2E fixture and the visual fixture, where `VoiceButton` falls back to
   * the stub that describes the room and answers nothing — see `engine.ts`.
   */
  agent?: AgentEngine;
  /**
   * Open the right panel on Chat, with this note already the room.
   *
   * The note's right-click menu is the caller, and it deliberately hands over
   * no question: the person has not typed one. What it does is put them in
   * front of the composer with the note already named in the ambient place —
   * ⌘K's row is the path that carries words, because there somebody typed
   * some.
   *
   * Absent where there is no panel to open. Every compact layout is that, and
   * so are the three surfaces with no console around them, which is why the
   * menu row is gone rather than inert there.
   */
  onAskAgent?: () => void;
}

const VoiceHostContext = createContext<VoiceHost | null>(null);

export function VoiceHostProvider({ value, children }: { value: VoiceHost; children: ReactNode }) {
  return <VoiceHostContext.Provider value={value}>{children}</VoiceHostContext.Provider>;
}

/** `null` on every surface that does not offer voice capture. */
export function useVoiceHost(): VoiceHost | null {
  return useContext(VoiceHostContext);
}
