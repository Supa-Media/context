/**
 * What a project's List is handed to add, nest and move tasks with, beyond
 * the property writes its notes source already makes. Built by the console
 * (`panes/browsePane/useTaskHost.ts`) from the file browser's own actions;
 * absent where nobody may write, and the List then offers none of it.
 */

import type { TaskWriteIO } from "./taskWrites";

export interface TaskHost {
  /**
   * The console's own create, move and remove (`taskWriteIO`); its
   * `setProperties` is replaced by the page's, which draws a choice at once.
   */
  readonly io: TaskWriteIO;
  /** A toast: what just happened, with Undo beside it when there is one (`FileBrowser.say`). */
  say(message: string, undo?: () => void): void;
  /** Read these folders' listings again, so a row that moved is where it went. */
  refresh(folders: readonly string[]): void;
  /** The console's archive dialog, for one or several. Absent where there is none. */
  archive?(paths: readonly string[]): void;
  /** Copy the link to a task, the share sheet's own team link. Absent for who may not make one. */
  copyLink?(path: string): void;
  /** Put what a write created or moved into this device's copy (`ListWriteBack.remember`). */
  remember?(written: readonly string[], gone: readonly string[]): Promise<void>;
}
