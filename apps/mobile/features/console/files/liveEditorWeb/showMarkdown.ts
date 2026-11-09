import { ViewPlugin, type EditorView } from "@codemirror/view";
import { markdownShown, setMarkdownShown } from "../livePreview/symbols";
import { getSpelling, subscribeSpelling } from "../spelling/store";

/**
 * Show Markdown (Settings › Writing) followed by an open web editor: switched
 * in Settings, the note on screen redraws at once. The native editor is told
 * by its host instead (`webview/host/bridge.ts`), because its page has no
 * account of its own. See `livePreview/symbols.ts`.
 */
export const followShowMarkdown = ViewPlugin.fromClass(
  class {
    private readonly unsubscribe: () => void;

    constructor(view: EditorView) {
      this.unsubscribe = subscribeSpelling(() => {
        const shown = getSpelling().showMarkdown;
        if (!view.dom.isConnected || view.state.field(markdownShown, false) === shown) return;
        view.dispatch({ effects: setMarkdownShown.of(shown) });
      });
    }

    destroy() {
      this.unsubscribe();
    }
  },
);
