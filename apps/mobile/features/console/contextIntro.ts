import { useCallback, useEffect, useState } from "react";
import { openStore } from "../offline/store";
import { tierSentence } from "./visibility";

/**
 * What a reader of somebody else's context is owed about their relationship to
 * it — said once, in one band, rather than stacked and for ever.
 *
 * ## What was on the screen
 *
 * A `member` of a shared context got two full-width bands above every note,
 * every folder and every listing, on every load, permanently:
 *
 *   Team access — notes marked private are not shown here.
 *   This is Context's own workspace, not yours — read anything here, and use a
 *   form to file a bug or a request. Your own notes are never in it.
 *
 * and, two inches above both, the `team level only` chip that the frame draws
 * on every route of the context anyway. Three statements of one relationship,
 * none of them dismissible, on a workspace — the pinned `@context-lc` — that
 * every account has in its rail and visits repeatedly. The owner reported them
 * as useless, and the useless part is not the sentences: it is that a *status*
 * was being drawn as *news*, and drawn twice.
 *
 * ## The split this module makes
 *
 * **A status belongs to the chip, which is already permanent and one pill
 * high.** `tierChipLabel` renders `team level only` in the pane head on every
 * route, for exactly the readers these sentences are for, and the paragraph
 * behind it (`tierExplanation`) is on the members card where somebody who
 * wonders goes looking. Neither is touched here, and between them the fact that
 * a view is filtered is still stated on every screen of the console.
 *
 * **A band is for something this reader has not been told yet.** So the
 * sentences are one notice, shown until it is answered, and the answer is
 * written down per context — a team link still lands a stranger in a filtered
 * listing with the line above it, which is the case the previous iteration
 * moved this notice onto every screen for, and that case is a *first* screen,
 * not every screen for ever.
 *
 * ## Why one band and never two
 *
 * They overlap most exactly where they were most annoying. On the pinned
 * context, "notes marked private are not shown here" is a technicality — you
 * are a visitor in Context's own docs — and the pinned sentence already says
 * the whole relationship, including the one thing a visitor can do. So the
 * pinned sentence replaces it rather than sitting under it. Elsewhere a
 * `member` gets both halves, because they are genuinely two facts (what you
 * cannot see, and what you cannot write), joined into one paragraph.
 *
 * ## Why the dismissal is a device flag, unlike the storage migration's
 *
 * `StorageMigration` argues at length that a device flag was the wrong home
 * for *its* answer, and it was: "has this bucket been migrated?" is a fact
 * about a bucket, the bucket knows it, and an answer that lives on one browser
 * is one that nags every other. This is the opposite shape. "Has this person
 * read a sentence about their own access?" is a fact about a person on a
 * screen, nothing else can observe it, and no table in the control plane holds
 * it — adding one for a read hint would be the over-building that argument
 * does not license. The cost is bounded and visible: a new browser is told
 * once more, which is what a first-time reader gets anyway.
 *
 * ## What answering it costs, said plainly
 *
 * The read tier survives on the chip; the *write* half does not have an
 * equivalent. A `member` who has answered this and later tries to type gets an
 * editor that does not take the keystroke and no sentence saying why — the
 * note's status row carries `Read-only` for a file this console *generates*
 * (`editor.ts`), not for a context somebody cannot write to. That is a real
 * cost and it is accepted rather than overlooked: the reader dismissed a line
 * that had just told them so, and the alternative on offer was a band above
 * every note for ever. If it ever bites, the fix is a word in that status row
 * — where the question is actually asked — and not this band coming back.
 */

/**
 * The notice for this reader's relationship to this context, or `null` when
 * there is nothing to say.
 *
 * `kind` is not cosmetic: it is part of the dismissal key, so a reader promoted
 * from `member` to `editor` is told once that write access arrived without the
 * private notes coming with it. Answering the old sentence does not answer the
 * new one.
 *
 * `null` for an owner and `null` while the role is still loading, by
 * construction in `tierSentence` rather than by a check here — see its comment
 * on why "assume filtered until proven otherwise" puts *Team access* in front
 * of somebody's own context on every cold load.
 */
export function contextIntro(view: {
  role?: string | null;
  /** True on the pinned `@context-lc`, which nobody was invited to. */
  pinned?: boolean;
  canEdit: boolean;
  /** `useFileBrowser`'s sentence for a context this person cannot write to. */
  readOnlyReason?: string;
}): { kind: string; text: string } | null {
  /*
    The pinned context, whose own sentence is the more informative of the two
    and is drawn whatever the role: it says what this workspace *is* and names
    the thing a visitor can do — file a bug through a form — which is the whole
    reason the row is in their rail. "Notes marked private are not shown here"
    under it is a second, smaller claim about the same relationship.
  */
  if (view.pinned === true) {
    return view.readOnlyReason === undefined
      ? null
      : { kind: "pinned", text: view.readOnlyReason };
  }

  const tier = tierSentence(view.role);
  // The same condition the band has always drawn this under: a reason exists
  // *and* this person cannot write. An editor has a reason recorded for a role
  // they no longer hold nothing to do with.
  const readOnly = !view.canEdit ? (view.readOnlyReason ?? null) : null;
  if (tier === null && readOnly === null) return null;

  return {
    kind: `${typeof view.role === "string" ? view.role : "unknown"}${
      readOnly === null ? "" : "+read-only"
    }`,
    text: [tier, readOnly].filter((part) => part !== null).join(" "),
  };
}

/**
 * Where an answered intro is remembered, per context and per kind.
 *
 * Its own key rather than one of `features/offline/keys.ts`', for
 * `storageMigrationDismissedKey`'s reason: that scheme is for *copies of what a
 * bucket said*, swept and invalidated as a cache, and this is neither a copy
 * nor disposable — forgetting it puts the band back in front of somebody who
 * has already read it.
 */
export function contextIntroDismissedKey(workspaceId: string, kind: string): string {
  return `context.lc.context-intro.dismissed.v1.${kind}.${workspaceId}`;
}

/** Remember that this context's intro has been read, on this device. */
export function dismissContextIntro(workspaceId: string, kind: string): void {
  void openStore()
    .set(contextIntroDismissedKey(workspaceId, kind), "1")
    .catch(() => {});
}

/**
 * Whether to draw the intro for this context, and how to answer it.
 *
 * ## Why it starts hidden
 *
 * The device is asked before anything is drawn and `visible` is false until it
 * answers, exactly as `useStorageMigrationOffer` does in this same band. A
 * notice that appears and then vanishes half a frame later is a layout jump on
 * the surface somebody came to read, and it would happen on every load for
 * every reader who has already answered — which is most of them, and is the
 * complaint this module exists for.
 *
 * A read that fails is treated as answered, for that same reason: a band
 * nobody can put away durably is worse than no band, and the fact it states is
 * on the chip either way.
 *
 * `null` for a context with nothing to say, so the caller's guard stays one
 * expression and this hook is still called unconditionally.
 */
export function useContextIntro(
  workspaceId: string | null,
  kind: string | null,
): { visible: boolean; dismiss: () => void } {
  const key =
    workspaceId === null || kind === null ? null : contextIntroDismissedKey(workspaceId, kind);
  const [answered, setAnswered] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    void openStore()
      .get(key)
      .then((stored) => {
        if (!live) return;
        setDismissed(stored !== null);
        setAnswered(key);
      })
      .catch(() => {
        if (live) setDismissed(true);
      });
    return () => {
      live = false;
    };
  }, [key]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (workspaceId === null || kind === null) return;
    dismissContextIntro(workspaceId, kind);
  }, [workspaceId, kind]);

  return { visible: key !== null && answered === key && !dismissed, dismiss };
}
