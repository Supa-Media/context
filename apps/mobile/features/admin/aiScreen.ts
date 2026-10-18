/**
 * What every screen of the AI tab is handed by `./AiSection`: the catalog of
 * `@context-lc ai/`, the scores notes read so far, and the ways out (another
 * place, a reload after a save, the note opened in the notes app).
 */

import type { Id } from "@context/convex/_generated/dataModel";
import type { AiCatalog } from "./aiCatalog";
import type { RunRead } from "./aiModel";
import type { AiPlace } from "./aiPlace";

export interface AiScreenProps {
  workspaceId: Id<"workspaces">;
  catalog: AiCatalog;
  /** Each scores note's latest scored section, by path, once read. */
  reads: ReadonlyMap<string, RunRead>;
  go: (place: AiPlace) => void;
  /** Read the folder again: after a save, a promotion or a new note. */
  reload: () => void;
  openInNotes: (path: string) => void;
  /** Who is signed in, for `promoted_by:` and `made_by:`. */
  me: string;
}
