/**
 * Facade. The file editor's `FileBrowser` contract, its supporting types and
 * the shared error-classification helpers now live under `./browser/`, split
 * by subject:
 *
 *  - `./browser/contract.ts` — the `FileBrowser` interface itself and
 *    `loadedFolders`.
 *  - `./browser/supportingTypes.ts` — `SearchAnswer`, `MoveDestination` and
 *    `ContextMoveProgress`.
 *  - `./browser/errors.ts` — `toFileError` and `isServerRefusal`, the funnel
 *    between a thrown `ConvexError` and what may reach somebody's screen.
 *
 * This file re-exports all of it so no existing import of `./browser` needs
 * to change.
 */

export type { FileBrowser } from "./browser/contract";
export { loadedFolders } from "./browser/contract";
export type { SearchAnswer, MoveDestination, ContextMoveProgress } from "./browser/supportingTypes";
export { toFileError, isServerRefusal } from "./browser/errors";
