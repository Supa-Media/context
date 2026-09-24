import { useMemo, useState } from "react";
import type { FileBrowser } from "../../files/browser";
import { contextMoveNotices } from "../../files/contextMoveNotice";
import {
  storageMigrationWorthOffering,
  useStorageLayoutObservation,
  useStorageMigrationOffer,
} from "../../storage/StorageMigration";
import type { ConsoleData, selectedContext } from "../../types";
import { contextIntro, useContextIntro } from "../../contextIntro";
import { contextSetupFor, setupPromptVisible } from "../../setup";

/**
 * What the band above the note has to say, and whether it has anything: the
 * missing bucket, the broken manifest, the setup offer, the intro sentence,
 * moves into other contexts and the storage-layout offer.
 */
export function useBrowseNotices({
  data,
  files,
  current,
  compact,
}: {
  data: ConsoleData;
  files: FileBrowser;
  current: ReturnType<typeof selectedContext>;
  compact: boolean;
}) {
  /*
    `=== null`, and never `!== undefined`. A binding that has not answered is
    not a context without one — see `ConsoleData.storage`. The `!data.loading`
    that used to stand here looked like the same guard and was not: `loading`
    is the *workspace list*, and the binding is a round trip behind it, so this
    banner offered to connect a bucket that was already connected on every
    refresh.
  */
  const noBucket = data.storage === null;
  const manifestBroken = files.listings[""]?.manifestUsable === false;
  /*
    THE CONTEXT NOBODY FINISHED SETTING UP.

    A layout is chosen in `/welcome` or `/workspace/new`, and both can be left
    for good: the managed-storage card goes to Stripe, and Stripe returns to
    Premium settings because those flows are component state with no URL to
    resume. What that leaves is an owner in this console, on a verified and
    entirely empty bucket, being told by the notice below that `privacy.md`
    could not be read — with nothing on screen that would write one.

    So the offer is drawn here, in the band that is already about the state of
    this context's storage. `../setup.ts` owns when, and it is deliberately
    narrow: a bucket the verifier has positively reported as empty, never one
    it has not looked in.
  */
  const setup = contextSetupFor({
    role: current?.role,
    storage: data.storage,
    /*
      The listing in front of the person, not the binding's memory of one.

      `scaffoldReason` is written only by verification, so a context filled in
      by a connected AI client still carries `empty` — which is how the first
      version of this card came to announce "This context is empty" over a
      workspace full of notes. The root listing is the live answer and
      `contextSetupFor` treats an unread one as silence.
    */
    root: files.listings[""],
    structureTemplate: current?.structureTemplate,
  });
  /*
    Ask the bucket before offering anything, once per context.

    `storageMigrationWorthOffering` now needs the bucket to have *answered*
    that it has never run this, and for a context migrated before any of that
    was recorded the answer only exists once somebody asks. This asks — it runs
    no migration and writes nothing to the bucket — and the notice below stays
    away until it comes back. The owner gate is the same one the control has:
    `updateStorageLayout` is `undefined` for anybody else, and so is this.
  */
  useStorageLayoutObservation(
    files.updateStorageLayout === undefined ? null : files.contextId,
    data.storage,
    data.storageActions?.observeLayout,
  );

  /**
   * The one-time storage-layout update, offered where it can be ignored.
   *
   * It used to be a gear in the file tree's toolbar — permanent chrome for an
   * operation somebody runs once or never — and it is a line in this band
   * instead, with its permanent home in Settings → Storage. Both surfaces are
   * gated on the same absent-or-present `updateStorageLayout`, which is
   * owner-only; nothing here decides who may run it.
   *
   * The workspace is what the *browser* says it is, not the console: this
   * notice belongs to the listings on screen, and `files.contextId` is what
   * everything else in this pane is drawn from while a switch settles.
   *
   * `storageMigrationWorthOffering` is the half that belongs to the notice
   * and not to the control — see its own comment. An owner with no bucket
   * connected is being told so by the warn notice below, and offering to
   * reorganize the hidden files of a bucket that does not exist under it is
   * noise at the worst possible moment.
   */
  const storageMigration = useStorageMigrationOffer(
    files.updateStorageLayout === undefined || !storageMigrationWorthOffering(data.storage)
      ? null
      : files.contextId,
  );
  /*
    WHAT THIS CONTEXT IS TO THE PERSON READING IT — ONE BAND, ANSWERED ONCE.

    Browse is the pane where an absence is invisible: a folder the owner keeps
    private does not appear in the tree, so somebody reading a short list has no
    way to tell a small context from a filtered one. That is why a sentence
    exists here at all, and why it is drawn wherever you are rather than only
    where nothing is open — a team link opens straight into a note, so the
    reader with the least context was the one nobody told.

    What that argument never licensed is the screen it produced: two permanent
    full-width bands, stacked, above every note of a context somebody visits
    daily, under a `team level only` chip already saying the same thing. The
    fact is a *status* and the status has a home — the chip, on every route of
    this context, with `tierExplanation` on the members card for anybody who
    wonders what it means. A band is for what this reader has not been told yet,
    so it is shown until it is answered and the answer is written down per
    context. `contextIntro.ts` holds both halves of that argument.

    Once per screen, still: this is the only place it is built, and it reaches a
    note through `notices` and a folder through the page scroller — the two
    branches at the foot of this file, never both.

    `null` for an owner, and `null` while the role is still loading — by
    construction in `tierSentence` rather than by a check here; see its comment.
  */
  const intro = contextIntro({
    role: current?.role,
    pinned: current?.pinned,
    canEdit: files.canEdit,
    readOnlyReason: files.readOnlyReason,
  });
  const introAnswer = useContextIntro(current?.id ?? null, intro === null ? null : intro.kind);
  /*
    The demo keeps its line permanently, and it is the one case where that is
    right: on the landing page this band reads "This is a demo. Sign in to edit
    your own workspace", which is the page's call to action rather than an
    orientation somebody is finished with. Nothing is written down for it and
    there is no control to press.
  */
  /*
    AND A PHONE KEEPS ITS LINE, BECAUSE A PHONE HAS NO CHIP.

    The whole argument for answering this band is that the fact it states does
    not go anywhere: `team level only` is on the chip, on every route. That is
    true at a pointer width and **false at `compact`** — `TierChip` has one call
    site, `topTrailing={phone ? <note actions> : <TierChip …>}`, and `phone`
    there is this same `densityFor(width) === "compact"`. At a phone's width the
    frame draws no chip, so answering the band would leave a `member` reading a
    filtered listing with nothing on screen saying things are missing from it.

    This is the second time that has been reached. The comment this block
    replaced recorded the first — *"a safeguard asserted in a comment and
    missing from the screen is worse than none, because it stops anybody
    looking for the real one"* — about the same chip and the same density.

    Drawn without a control rather than with one that does nothing: a `Got it`
    that comes back on the next load reads as broken. The phone still gains
    #719's real win, which was one band instead of two stacked.

    The other fix is to give the phone a chip. That is a change to what the
    phone's trailing capsule holds, which the layout argues at length is
    spoken for by the note's own actions — a design decision rather than this
    one, and the conservative half is here.
  */
  const introVisible =
    intro !== null && (data.demo === true || compact || introAnswer.visible);

  /*
    MOVES INTO ANOTHER CONTEXT, WHICH FINISH AFTER THE PRESS THAT STARTED THEM.

    Every other operation reports itself by the tree changing while somebody
    watches. This one can still be running minutes later, in a scheduled action
    on a server, with nothing on this device involved — so it gets a line here,
    in the band that already holds "something is happening and it is yours to
    know about".

    Dismissal is per move and only for a finished one (see
    `contextMoveNotices`), and it is written down: a finished row stays
    listable for a day, so a set that lived only here meant the same line on
    every launch until it aged out — a Dismiss button that worked until you
    closed the app. The durable half is `dismissContextMove`; this set is what
    covers the round trip.
  */
  const [dismissedMoves, setDismissedMoves] = useState<ReadonlySet<string>>(new Set());
  const moveNotices = useMemo(
    () => contextMoveNotices(files.contextMoves, dismissedMoves),
    [files.contextMoves, dismissedMoves],
  );

  const hasNotice =
    introVisible ||
    setupPromptVisible(setup) ||
    noBucket ||
    manifestBroken ||
    files.notice !== null ||
    moveNotices.length > 0 ||
    storageMigration.visible;

  return {
    noBucket,
    manifestBroken,
    setup,
    storageMigration,
    intro,
    introAnswer,
    introVisible,
    setDismissedMoves,
    moveNotices,
    hasNotice,
  };
}

/** What `useBrowseNotices` hands back. */
export type BrowseNoticeState = ReturnType<typeof useBrowseNotices>;
