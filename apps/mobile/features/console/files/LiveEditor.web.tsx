/**
 * The Live Preview editor, on web.
 *
 * The implementation lives in `liveEditorWeb/`, one module per
 * responsibility: the component and its effects, the build of the view, the
 * collaborative binding, the right-click menu, the stylesheet and the props
 * contract. This path stays the entry point, because its `.web.tsx` suffix is
 * what makes the web bundler pick it over `LiveEditor.tsx`, and because the
 * native half and every caller import the contract types from here.
 */

export { LiveEditor } from "./liveEditorWeb/LiveEditor.web";
export type { EditorControls, LiveEditorProps } from "./liveEditorWeb/contract";
