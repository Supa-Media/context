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

/**
 * Whether the tree's visibility markers are controls rather than facts.
 *
 * Both halves matter and neither implies the other: a console that cannot act
 * at all must offer nothing, and an editor who can act must still not be
 * offered a clearance decision. The server says the same thing with
 * `minimum: "owner"` on `setNoteVisibility` and `setDirectoryVisibility`.
 *
 * This lived inline in `useFileBrowser` and was **the capability the console's
 * one real authorization defect was about** — and dropping its `isOwner` half
 * there failed nothing across 1476 checks, because a hook that also calls a
 * dozen Convex hooks is not somewhere a test can reach.
 */
export function canSetVisibility(caps: ConsoleCapabilities): boolean {
  return caps.canEdit && caps.isOwner;
}

/**
 * Whether to offer the repair for a `privacy.md` that will not parse.
 *
 * Three things, and the third is the one that is easy to drop: the console has
 * to be able to act, the caller has to be the owner — rewriting the access map
 * is not an editor's to do — **and the manifest has to actually be broken**,
 * because `resetPrivacyManifest` refuses one that parses (`PRIVACY_MANIFEST_USABLE`).
 * Offering it otherwise is a button whose only outcome is a refusal.
 *
 * `manifestUsable` is `undefined` while the root listing is still loading, and
 * that must read as "do not offer" rather than "broken" — a repair button that
 * flashes during load is the console's version of a floor printed as a total.
 */
export function canResetPrivacy(
  caps: ConsoleCapabilities,
  manifestUsable: boolean | undefined,
): boolean {
  return caps.canEdit && caps.isOwner && manifestUsable === false;
}

/**
 * Whether a Share control exists at all.
 *
 * The same two halves as `canSetVisibility`, and for the same reason rather
 * than by copying: sharing a note is a decision about **who reads it**, which
 * is exactly the authority PR #93/#95 took away from editors on three other
 * surfaces. An editor may write a note and may not hand it to somebody outside
 * the context; `createShare` refuses them with `minimum: "owner"` whatever this
 * returns.
 *
 * It is a separate function from `canSetVisibility` even though the expression
 * is identical today, because the two answer different questions and will not
 * necessarily stay identical — collapsing them would mean a future decision to
 * let editors share silently also handed them the access map.
 *
 * Pure and here rather than inline in `useFileBrowser`, for the reason at the
 * top of this file: the console's one real authorization defect lived inline in
 * that hook and survived a full sabotage sweep untouched.
 */
export function canShare(caps: ConsoleCapabilities): boolean {
  return caps.canEdit && caps.isOwner;
}
