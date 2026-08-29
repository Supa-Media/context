/**
 * What a role may do in the console, decided in one place.
 *
 * This is the same rule `toolsForSession` follows in the gateway — authority is
 * decided once, never per surface — and it is here because of what happened
 * when it was not. Every capability below was previously an inline expression
 * inside `useLiveConsoleData`, a hook that also calls a dozen Convex hooks and
 * is therefore hard to mount in a test. Mutating each of them in place produced
 * **zero failures across all 1476 checks**: `canEdit` accepting any role, and
 * `isOwner` hardcoded `true`, both went entirely unnoticed.
 *
 * That was not an accident of coverage. Across a full sabotage sweep of the
 * console file browser, **every guard expressed as a pure module was held and
 * every guard expressed inside a hook or a component was not** — `menu.ts`,
 * `dnd.ts`, `paths.ts` and `editor.ts` caught 13 mutations between them, while
 * `useFileBrowser.ts`, `Explorer.tsx` and this file's derivations caught none.
 * So the fix is not "write a harder test", it is to move the decision somewhere
 * a test can reach.
 *
 * ## The two are not one
 *
 * `canEdit` is "may write notes"; `isOwner` is "may decide who reads them".
 * CLAUDE.md is explicit that read access and write access are different grants
 * and that write is never implied — and the server agrees twice over, with
 * `minimum: "editor"` on the note operations and `minimum: "owner"` on
 * `setNoteVisibility`, `setDirectoryVisibility` and `resetPrivacy`. Collapsing
 * these into one boolean would offer an editor the access map, which is the
 * control PR #93/#95 removed from three surfaces after an editor used it.
 *
 * ## An unknown role is not a permissive one
 *
 * `undefined` is what a console with nothing selected has, and a role this
 * deployment does not recognise is what a newer control plane would send. Both
 * answer `false` to everything, because the direction this must fail is "offer
 * less than the server allows" — a control that is absent costs somebody a
 * click, and one that is present and refused is the defect this module exists
 * to stop.
 */
export interface ConsoleCapabilities {
  /** May write notes: create, rename, move, copy, archive, delete. */
  canEdit: boolean;
  /** May change who can see them, and repair the access map. */
  isOwner: boolean;
}

export function capabilitiesForRole(role: string | undefined): ConsoleCapabilities {
  return {
    canEdit: role === "owner" || role === "editor",
    isOwner: role === "owner",
  };
}
