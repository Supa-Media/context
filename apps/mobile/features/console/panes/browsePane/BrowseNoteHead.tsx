import type { Dispatch, SetStateAction } from "react";
import { View } from "react-native";
import { FrameIconButton } from "../../../app/AppFrame";
import { noteGutterFor } from "../../../app/frame";
import { useThemedStyles } from "../../../design/theme";
import type { useConsoleNav } from "../../ConsoleNavContext";
import { Breadcrumb } from "../../files/Breadcrumb";
import type { FileBrowser } from "../../files/browser";
import { noteHeading } from "../../files/frontmatter";
import { setReadMode } from "../../files/readMode";
import type { entryAt } from "../../files/tree";
import { makeStyles } from "./styles";
import type { FolderListingState } from "./useFolderListing";

/**
 * The pointer layout's header over the open note or folder: the breadcrumb,
 * reading mode and Share. Only drawn where `BrowsePane` says so.
 */
export function BrowseNoteHead({
  files,
  selected,
  nav,
  reading,
  headWidth,
  setHeadWidth,
  setSharing,
  openCrumbMenu,
}: {
  files: FileBrowser;
  selected: NonNullable<ReturnType<typeof entryAt>>;
  nav: ReturnType<typeof useConsoleNav>;
  reading: boolean;
  headWidth: number;
  setHeadWidth: Dispatch<SetStateAction<number>>;
  setSharing: Dispatch<SetStateAction<string | null>>;
  openCrumbMenu: FolderListingState["openCrumbMenu"];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    /*
      THE PAGE'S OWN HEADER, NOT A TOOLBAR ACROSS THE TOP OF THE REGION.

      This row had a fill, a hairline under it and its crumbs against the
      region's left edge, so it read as a band of chrome with the note
      starting underneath — three horizontal rules stacked down the window
      once the status bar and the top bar were counted. The design draws a
      page: a quiet line of path where the note's own first character is,
      and the note under it.

      So the fill and the rule are gone (`Breadcrumb.bar`), and the crumbs
      are indented to `noteGutterFor` — the same sum `LiveEditor.web.tsx`
      spends in CSS, from the width this row is measured at, which is the
      editor's width because they are the same column.

      The actions do not move with it. They stay at the region's trailing
      edge, floating over the note the way the design has them: `gutter`
      pads the crumb alone rather than the row.
    */
    <View
      style={styles.noteHead}
      onLayout={(event) => setHeadWidth(event.nativeEvent.layout.width)}
    >
      <View style={[styles.crumb, { paddingLeft: noteGutterFor(headWidth) }]}>
        <Breadcrumb
          path={selected.path}
          /*
            `‹ ›` at the head of the path, on a pointer. The phone's
            breadcrumb is `pathOnly` and draws neither: its bottom bar has
            carried the same pair over the same `history.ts` stack all
            along, and two of one control on a 390pt screen is what the
            second drawer toggle was deleted for being.
          */
          history={
            nav === null
              ? undefined
              : {
                  canBack: nav.canBack,
                  canForward: nav.canForward,
                  onBack: nav.back,
                  onForward: nav.forward,
                }
          }
          /*
            What the note calls itself, where it calls itself anything.

            Only when the editor is holding *this* note: `files.editor` is
            one buffer and the selection can move ahead of it, so titling
            the breadcrumb from a draft belonging to a different path would
            put one note's subject over another note's name. A folder has no
            text and gets no title, which leaves `baseName` — its own name,
            which is what a folder is called.
          */
          title={
            selected.kind === "file" && files.editor.path === selected.path
              ? noteHeading(files.editor.draft, selected.path)
              : undefined
          }
          visibility={selected.visibility}
          inherited={selected.inherited}
          exception={selected.exception}
          readOnly={selected.readOnly}
          onSelectFolder={files.select}
          onFolderMenu={openCrumbMenu}
        />
      </View>
      {/*
        Share is here, beside the note, and not only in the row's menu.

        It was menu-only first, and that made it a feature nobody had: on a
        phone the menu is a long-press on a *file row*, so somebody reading
        a note — which is exactly when they decide to send it to a
        colleague — had no row to press and no button to find. `Empty`
        below already states the rule this broke: "a right-click menu
        nobody discovers is a feature nobody has."

        It stays in the menu too. The menu is how you act on a note you are
        not looking at; this is how you act on the one you are.

        Absent rather than disabled for anyone who is not the owner, and
        absent for `privacy.md` and anything else read-only — the same rule
        the menu applies, and the server refuses it regardless with
        `minimum: "owner"`.
      */}
      {/*
        A folder as well as a note. `FolderView` used to draw its own pair
        and no longer does — see its header — so this is the one place a
        pointer layout offers either, and the phone's answer is the frame's
        trailing group. What a share *means* still differs by kind, and
        that is `ShareDialog`'s to say rather than this button's.
      */}
      {/*
        Absent for a group rule, the console's own rule for a control
        somebody may not use. The two-word button has no true label for
        `@supa-leads` — it said "Share with team", and pressing it did
        exactly that to a note the owner had held back.
      */}
      {/*
        One control, and it is the phone's glyph.

        This row carried two filled word-buttons — "Make private" and
        "Share…" — which were the widest thing in the bar, and #461 turned
        both into icons. That was half right and half a regression: the
        *padlock* is a control `_layout.tsx` had already taken off the
        phone, and its comment there says why — "two controls for one
        question", overlapping on the dangerous state, with audience moved
        inside the sheet as named positions and the public step confirmed in
        words. Drawing it here as a 20pt icon reintroduced on a pointer
        layout exactly what the phone removed, which is the opposite of
        matching it.

        So visibility is gone from this row. `ShareDialog` below already
        takes `onSetScope`, so nothing moved and nothing is unreachable —
        audience is set where the phone sets it, and `scope.ts` is still the
        one model every surface goes through.

        Share stays, unfilled rather than in a capsule: `AppFrame`'s
        trailing group is a floating container over a document and is itself
        the object, while this bar has a surface and a hairline already, so a
        box around one glyph would be the box-in-a-box the frame's own
        comment refuses at every density but the phone.
      */}
      {/*
        READING MODE, ON THE LAYOUT THAT HAD NO WAY INTO IT.

        The eye was added to `AppFrame`'s trailing group, and that group is
        **only drawn on a phone** — `_layout.tsx` passes `topTrailing` under
        `phone ? … : …` and the pointer branch carries the tier and storage
        chips instead. So reading mode shipped reachable on a 390pt screen
        and unreachable in a browser, which is where it was asked for: "add
        this to web as well because it doesn't show up on web".

        Same bus, same state, same label rule as the phone's — one control
        in two places rather than two controls, and `readable` there is the
        same condition as `kind === "file"` here. A **folder** selects this
        row too and gets no eye: there is no document to read, which is the
        reason `_layout.tsx` gives for the same gate.
      */}
      {selected.kind === "file" ? (
        <FrameIconButton
          icon={reading ? "pencil" : "eye"}
          label={reading ? "Edit this note" : "Read this note"}
          onPress={() => setReadMode(!reading)}
          testID="browse-read"
        />
      ) : null}
      {files.canShare && !selected.readOnly ? (
        <FrameIconButton
          icon="share"
          label="Share this"
          onPress={() => setSharing(selected.path)}
          testID="browse-share"
        />
      ) : null}
    </View>
  );
}
