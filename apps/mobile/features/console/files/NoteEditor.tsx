/**
 * The note itself: markdown, drawn as the document it is.
 *
 * The implementation lives in `noteEditor/`, one module per piece of the
 * surface; `noteEditor/NoteEditor.tsx` carries the argument for how it is
 * drawn. This path stays the one every caller and test imports.
 */

export { NoteEditor } from "./noteEditor/NoteEditor";
export { withVisibility } from "./noteEditor/Properties";
export type { NoteEditorProps } from "./noteEditor/props";
