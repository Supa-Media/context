import { createContext, useContext, type ReactNode } from "react";
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
}

const VoiceHostContext = createContext<VoiceHost | null>(null);

export function VoiceHostProvider({ value, children }: { value: VoiceHost; children: ReactNode }) {
  return <VoiceHostContext.Provider value={value}>{children}</VoiceHostContext.Provider>;
}

/** `null` on every surface that does not offer voice capture. */
export function useVoiceHost(): VoiceHost | null {
  return useContext(VoiceHostContext);
}
