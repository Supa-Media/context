/**
 * The iOS editor's imperative handle, aimed at the bridge rather than at an
 * editor, because on this platform there is no editor in the host to aim at.
 * Split out of `LiveEditor.tsx`, which builds it once; see the note there.
 */

import type { MutableRefObject } from "react";
import type { EditorControls } from "../../liveEditorWeb/contract";
import type { HostBridge } from "./bridge";

export function bridgeControls(
  bridge: Pick<HostBridge, "run">,
  askLink: MutableRefObject<((text: string) => void) | null>,
): EditorControls {
  return {
    wrap: (before, after) => bridge.run({ name: "wrap", before, after }),
    toggleLinePrefix: (prefix) => bridge.run({ name: "toggleLinePrefix", prefix }),
    /*
      The `ask` is held here rather than sent: a function cannot cross the
      bridge, so the guest is told only that there is one, and answers with a
      `link-request` that `LiveEditor`'s sink hands to it.
    */
    insertLink: (ask) => {
      askLink.current = ask ?? null;
      bridge.run(ask === undefined ? { name: "insertLink" } : { name: "insertLink", ask: true });
    },
    applyLink: (link) => bridge.run({ name: "applyLink", link }),
    cancelLink: () => bridge.run({ name: "cancelLink" }),
    undo: () => bridge.run({ name: "undo" }),
    redo: () => bridge.run({ name: "redo" }),
    blur: () => bridge.run({ name: "blur" }),
    /*
      Reachable, and deliberately not reached today: no phone build has a
      dictation engine (`features/voice/engine.ts`), so nothing calls this.
      It is wired anyway because the *joining* rule lives in `runCommand` on
      both sides of the bridge — a surface that grew an engine later and
      found this missing would reimplement the spacing and get it different.
    */
    dictate: (text) => bridge.run({ name: "dictate", text }),
  };
}
