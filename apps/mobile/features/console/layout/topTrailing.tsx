import type { Dispatch, SetStateAction } from "react";
import { FrameIconButton } from "../../app/AppFrame";
import { StagingPill } from "../../app/StagingNotice";
import { ConsoleLiveMeeting } from "../ConsoleLiveMeeting";
import { SaveChip, TierChip } from "../ConsoleShell";
import type { Dialog } from "../files/Explorer";
import { setReadMode } from "../files/readMode";
import { settingsHref } from "../nav";
import { DEFAULT_SETTINGS_SECTION } from "../settings/sections";
import type { ConsoleContext, ConsoleData } from "../types";
import { StorageChip } from "./chrome";
import type { ConsoleRouter } from "./types";

/**
 * The trailing group of the console's top bar.
 *
 * A function returning the element rather than a component, so the tree the
 * console layout renders is exactly the one it rendered when this was inline:
 * no extra fibre in `AppFrame`'s slots, nothing a render test can find twice.
 */
export function consoleTopTrailing({
  phone,
  readable,
  shareTarget,
  reading,
  setBarDialog,
  showMeetings,
  data,
  insideContext,
  current,
  router,
}: {
  phone: boolean;
  readable: boolean;
  shareTarget: string | null;
  reading: boolean;
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
  showMeetings: () => void;
  data: ConsoleData;
  insideContext: boolean;
  current: ConsoleContext | null;
  router: ConsoleRouter;
}) {
  /*
    Absent on a phone, where both chips have moved to the foot of the
    context's own page — `features/console/files/contextFoot.ts` composes
    the line and `FolderView` draws it.

    (This used to cite `ContextFoot` and `Explorer`'s `vault` slot. There
    is no such component — the module is `files/contextFoot.ts` — and the
    `vault` slot went with the phone's file tree, so the citation pointed
    at one name that never existed and one that no longer does.)

    They are facts *about the context you are in*: which bucket it is
    bound to, and what you are allowed to see in it. Under the context's
    own heading, at the foot of the page that lists it, they read as a
    caption. Floating over the note in the top-right corner of a 390pt
    screen they read as chrome about the note, which is what they were
    being mistaken for — and getting them there cost a bordered pill
    wrapping two bordered pills.

    The pointer layout keeps them in the bar. It has the width, the bar
    has a surface of its own to sit them on, and the tree's foot there is
    a 26pt strip at the bottom of a 260pt column rather than a page's.
  */
  return (
    phone ? (
      /*
        Obsidian's trailing group, holding the one action the note has
        that is not on the bottom toolbar.

        `AppFrame` draws the capsule; this passes what goes in it. Absent
        rather than dimmed when there is nothing to share — `menu.ts`
        states the rule for exactly this case, and an empty capsule
        floating over a note is chrome about nothing.

        It raises the dialog through `barDialog`, which `ExplorerDialogs`
        already renders below with its own `canShare` re-check. A second
        `ShareDialog` mounted here would be a second contract for one
        offer.
      */
      /*
        One control, not two.

        This group used to carry a padlock beside the share icon. They
        were two controls for one question — and worse, they overlapped
        on the dangerous state: the padlock cycled private → team →
        *link anyone can open*, minting exactly the share row the sheet's
        own "Create link" minted. Most notes sit at `team` already by
        folder inheritance, so a note was one tap on an unlabelled 20pt
        icon away from a link that needs no account.

        Audience lives inside the sheet now, as named positions with the
        public step confirmed in words — `ShareDialog`'s `onSetScope`
        carries the full argument. `scope.ts` is untouched: it is still
        the pure model of what the positions are and how to move between
        them, and `setScope` is still the single point every surface goes
        through. Only the control that drove it changed.
      */
      !readable && shareTarget === null ? undefined : (
        <>
          {/*
            Reading mode, leading the group.

            Before Share rather than after it, because the two are not
            peers: this changes how the note in front of you is drawn and
            is undone by pressing it again, and Share opens a sheet that
            grants somebody access. The reversible one is the safer
            neighbour for a thumb, and the group is read left to right.

            **The glyph is the act, and there is no `selected` fill.**
            This used to be one eye lit by `selected`, on the argument
            that one mark cannot draw "will hide the markup" and "will
            bring it back" — so the state went in the fill and the label
            carried the act. Two marks can draw it, and once they do the
            fill is not merely redundant but wrong: it would light the
            *pencil*, and a lit control says "this mode is on" while the
            pencil means "press to start editing". Icon and label now say
            the same thing, which is what an unlabelled 20pt target needs.
          */}
          {readable ? (
            <FrameIconButton
              label={reading ? "Edit this note" : "Read this note"}
              icon={reading ? "pencil" : "eye"}
              grouped
              onPress={() => setReadMode(!reading)}
              testID="note-read"
            />
          ) : null}
          {shareTarget === null ? null : (
            <FrameIconButton
              label="Share this"
              icon="share"
              grouped
              onPress={() => setBarDialog({ kind: "share", path: shareTarget })}
              testID="note-share"
            />
          )}
        </>
      )
    ) : (
      <>
        {/*
          A meeting that is running while the panel it lives in is folded
          away. It draws nothing when the panel is open — the card is
          right there — and nothing when nothing is recording, which is
          almost always. See `ConsoleLiveMeeting`.
        */}
        <ConsoleLiveMeeting onOpen={showMeetings} />
        {/*
          Whether the last keystroke is in the bucket, leading the group —
          see `SaveChip` for why this is a chip here rather than a Save
          button over the note. Not gated on `insideContext` either: it is
          a claim about the note that is open, and a note stays open
          behind Map, Connections and the settings overlay.
        */}
        <SaveChip editor={data.files.editor} />
        {/*
          Gated on `insideContext`, and the two chips beside it are not.
          That is deliberate rather than an oversight to tidy: a bucket is
          one fact about the selected context, but a tier is a claim about
          what *you* can see, and on an all-contexts route you may be
          looking at three contexts you hold three different roles in. One
          chip cannot speak for them, and the wrong direction for it to be
          wrong in is "you are seeing everything".
        */}
        {insideContext ? <TierChip role={current?.role} /> : null}
        <StorageChip
          data={data}
          onOpenSettings={
            current === null
              ? undefined
              : /*
                  `setParams` inside a context, a push out of one.

                  Both open the overlay now — it draws on every console
                  route — but only a context route carries the note in
                  its URL, and `setParams` is what keeps it there while
                  settings is over the top of it. From Map or Connections
                  there is no note to keep, and the push names the
                  context whose binding this chip is stating.
                */
                insideContext
                ? () => router.setParams({ settings: DEFAULT_SETTINGS_SECTION })
                : () => router.push(settingsHref(current.slug))
          }
        />
        <StagingPill />
      </>
    )
  );
}
