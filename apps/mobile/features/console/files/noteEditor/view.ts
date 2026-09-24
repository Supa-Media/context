import type { ScrollView } from "react-native";
import type { useSurfacePadding } from "../../../app/Screen";
import type { VoiceHost } from "../../../voice/VoiceHost";
import type { DurableCollaboration } from "../../collaboration/durable";
import type { saveButton } from "../editor";
import type { EditorControls } from "../LiveEditor";
import type { NoteEditorProps } from "./props";
import type { NoteEditorStyles } from "./styles";

/**
 * Everything the pieces of the note surface draw from, in one object.
 *
 * `NoteEditor` computes every one of these in its own body, in the order its
 * hooks require, and hands the result to the functions that return its
 * subtrees (`noteFlow`, `noteDocument`, `noteScroller`, `noteVoiceButton`).
 * Those are plain functions called during `NoteEditor`'s render, not
 * components, so the element tree React reconciles is exactly the one the
 * single component used to return.
 */
export type NoteView = Omit<NoteEditorProps, "activityShared" | "activityEditable"> & {
  activityShared: boolean;
  activityEditable: boolean;
  styles: NoteEditorStyles;
  editable: boolean;
  passphraseLocked: boolean;
  drawing: boolean;
  activityList: boolean;
  openedAt: number;
  button: ReturnType<typeof saveButton>;
  compact: boolean;
  bodyOnly: boolean;
  collaborativeChange: (text: string) => void;
  collaborativeVersionedChange: DurableCollaboration["onVersionedChange"] | undefined;
  setFocused: (focused: boolean) => void;
  dictateAsked: number | null;
  setDictateAsked: (at: number | null) => void;
  docWidth: number;
  setDocWidth: (width: number) => void;
  controls: { current: EditorControls | null };
  padding: ReturnType<typeof useSurfacePadding>;
  barUp: boolean;
  voice: VoiceHost | null;
  moving: { current: boolean };
  settledAt: { current: number };
  scroller: { current: ScrollView | null };
  offset: { current: number };
  frontmatter: string;
  body: string;
  titled: boolean;
  durability: string;
  canDiscard: boolean;
  explains: boolean;
  manualSave: boolean;
};
