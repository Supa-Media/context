/**
 * Facade. The native half of the bridge, with the React taken out.
 *
 * `LiveEditor.tsx` is a `WebView`, three effects and a ref. Everything it
 * actually *decides* — when a document is authoritative rather than an echo,
 * what a palette looks like as CSS, whether a `change` arriving from the web
 * view may be acted on, how much of the editor the keyboard is covering — is
 * under `./host/`, as functions over values, split by subject:
 *
 *  - `./host/document.ts` — `themeVars`, the HTML shell (`editorDocument`,
 *    `escapeForScript`, `EDITOR_HTML`) and the navigation refusal
 *    (`NAVIGATION_ORIGINS`, `allowInitialLoadOnly`).
 *  - `./host/bridge.ts` — `HostSink`, `HostBridge`, `createHostBridge` and the
 *    re-exported `bytesFromBase64`.
 *  - `./host/layout.ts` — `coveredHeight`, `CARET_MARGIN`, `caretOvershoot`,
 *    `ESTIMATED_HEIGHT` and `editorBox`.
 *
 * That split is not tidiness. `react-native-webview` has no web build: its
 * bare `WebView.js` renders "React Native WebView does not support this
 * platform", so a Jest suite that resolves `react-native` to
 * `react-native-web` can mount `LiveEditor.tsx` and learn nothing from it.
 * A bridge that is a component is a bridge that is tested on a device or not
 * at all. This one is tested in `webviewHost.test.ts`, in plain node.
 *
 * **Nothing here may import CodeMirror.** The guest bundle is a string; the
 * editor's code lives inside it. A `@codemirror/*` import in this file would
 * put a DOM library into the React Native module graph, which is the move
 * `supa-framework.test.js` exists to catch.
 *
 * Re-exported here so no existing import of `./webview/host` needs to change.
 */

export { themeVars, editorDocument, escapeForScript, EDITOR_HTML, NAVIGATION_ORIGINS, allowInitialLoadOnly } from "./host/document";

export { bytesFromBase64, LINK_PATHS_CAP, createHostBridge } from "./host/bridge";
export type { HostSink, HostBridge } from "./host/bridge";

export { coveredHeight, CARET_MARGIN, caretOvershoot, ESTIMATED_HEIGHT, editorBox } from "./host/layout";
