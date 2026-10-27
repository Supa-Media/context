import type { NoteEdit } from "../../routines/RoutineBar";

export interface PageViewProps {
  source: string;
  /** Whether the reader may change the note: typing, ticking, picking. */
  editable: boolean;
  /** The signed-in person as comments name them, or null where they cannot comment. */
  author: string | null;
  /** The note's own edit path (`wholeEdit`): merged into collaborators' typing, saved by autosave. */
  onEdit?: NoteEdit;
  onOpenNote?: (target: string) => void;
  onLoadImage?: (target: string) => Promise<string | null>;
  /** Scroll on its own (a pointer layout, where the region does not scroll the note). */
  scrolls?: boolean;
}
