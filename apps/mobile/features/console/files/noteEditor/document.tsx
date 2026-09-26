import { Platform, View } from "react-native";
import { PresenceChip } from "../../ConsoleShell";
import { noteGutterFor } from "../../../app/frame";
import { layout } from "../../../design/tokens";
import { DrawingEditor } from "../DrawingEditor";
import { ActivityPage } from "../../activity/ActivityPage";
import { LockedNoteView } from "../../encryption/LockedNoteView";
import { LiveEditor } from "../LiveEditor";
import { Properties } from "./Properties";
import { changeProperty } from "./propertyEdit";
import type { NoteView } from "./view";

/**
 * How long after the note comes to rest a focus still counts as part of the
 * swipe rather than as a press, in milliseconds.
 *
 * The trailing half of the rule in `NoteEditor`'s `moving`/`settledAt`, for the
 * two cases the flag itself cannot see: a slow drag that ends with no fling,
 * and the web, where only `onScroll` is forwarded. A quarter of a second —
 * long enough to cover a touch-up landing a frame or two after the last scroll
 * event, short enough that somebody who scrolls, stops, and then taps to type
 * gets their keyboard. Named here rather than typed at the call site because it
 * is the whole of the judgement.
 */
const SCROLL_GRACE_MS = 250;

/**
 * The document column: the Properties row over whichever of the four things
 * this note is drawn as — the activity list, a drawing, a locked envelope, or
 * the editor. Called from `noteFlow`, during `NoteEditor`'s render.
 */
export function noteDocument(view: NoteView) {
  const {
    compact,
    styles,
    setDocWidth,
    passphraseLocked,
    frontmatter,
    visibility,
    docWidth,
    activityList,
    activity,
    activityShared,
    openedAt,
    state,
    activityEditable,
    onOpenNote,
    drawing,
    canEdit,
    onChange,
    drawingCollaboration,
    encryption,
    presence,
    bodyOnly,
    body,
    editable,
    collaborativeChange,
    collaborativeVersionedChange,
    onSave,
    controls,
    moving,
    settledAt,
    setFocused,
    scroller,
    offset,
    notePaths,
    onOpenLink,
    onSuggest,
    onPickSuggestion,
    voice,
    setDictateAsked,
    onPreviewLinks,
    onSubmitForm,
    onReadFormResponses,
    onVoteForm,
    onUpdateFormResponse,
    onRetractFormResponse,
    onLoadImage,
    onStoreImage,
    onImageProblem,
    folderLists,
    onTitleCaret,
    titleNote,
  } = view;
  return (
    <View
      style={compact ? undefined : styles.document}
      /*
        The column's width, so the Properties row can start where the note's
        own first character does. Measured rather than derived from the
        window for `BrowsePane`'s reason: this is inside the editor region,
        and how much of the window that region gets depends on a tree
        somebody drags.
      */
      onLayout={
        compact ? undefined : (event) => setDocWidth(event.nativeEvent.layout.width)
      }
    >
        {/*
          The filing metadata, folded away — see `Properties` below and
          `frontmatter.ts`. Not for a passphrase note: its frontmatter is the
          marker and nothing a person filed.

          **This was compact only, and it is every density now** — half of
          the answer to "the desktop shows raw YAML". A phone was handed the
          body and this disclosure; a pointer layout was handed the file and
          drew `--- updated: … ---` in a dim mono block above the note's own
          title, on every note anybody had ever filed anything on.

          The other half is in `livePreview.ts`: the block is *hidden* in the
          editor until the caret is in it, the way every other mark in live
          preview behaves. That left nobody a way to change a property who
          did not already know the YAML was there, and a phone no way at all,
          so the panel edits too — one line at a time, through the editor's
          own `onChange` (see `Properties` and `propertyEdit.ts`).

          **What it draws differs by density, because what is beside it
          does.** A phone's breadcrumb carries no visibility chip, so the
          access-map answer is a row in here and the panel is drawn for it
          alone. A pointer layout's breadcrumb says who can see the note one
          line above, so this is drawn only where there is a block to fold —
          otherwise it would be an empty disclosure under a line that already
          answered it.
        */}
        {!passphraseLocked && (frontmatter !== "" || (compact && visibility !== undefined)) ? (
          <Properties
            frontmatter={frontmatter}
            visibility={compact ? visibility : undefined}
            /*
              A phone pays the note's reading margin; a pointer layout pays
              whatever puts this at the same character as the first line of
              the document, which is not a constant — the column is centred
              and moves with the width. `noteGutterFor` is the sum, and the
              editor below spends the same one in CSS.
            */
            gutter={compact ? layout.readingMargin : noteGutterFor(docWidth)}
            compact={compact}
            /*
              Through the same `onChange` a keystroke takes, so a property
              change saves, merges into a collaborator's typing and shows in the
              editor exactly as if it had been typed into the YAML.
            */
            onSet={
              editable && !drawing && !activityList
                ? (key, value, adding) => {
                    const shared = presence?.collaboration;
                    const current = shared?.text ?? state.draft;
                    const changed = changeProperty(current, key, value, adding);
                    if ("error" in changed) return changed.error;
                    if (changed.text === current) return null;
                    // Against the snapshot this text was read from, so an edit
                    // that arrived since this render is merged, never undone.
                    if (shared !== undefined) shared.onVersionedChange(changed.text, shared.revision);
                    else collaborativeChange(changed.text);
                    return null;
                  }
                : undefined
            }
          />
        ) : null}
        {activityList ? (
          /*
            The activity file opens as a list, and the pencil opens its
            Markdown.

            Not the drawing's trade below, and the difference matters. A
            drawing *must* not reach a text editor: one keystroke in that
            base64 and the diagram is gone. Nothing here is destroyed by
            typing — the region between the markers is rebuilt from
            `.context/audit/` on the next change and everything either side
            is kept forever (`renderFile` splices) — so refusing the editor
            would be the product deciding somebody may not look at their own
            file, on nothing but taste.

            What is true is that a dated list is a thing to *read*, and a
            text editor shows it with a machine comment after every line. So
            the list is the default and the source is a press away: `Open in
            new tab` works, a link to it works, and Obsidian draws it as the
            document it is.
          */
          <ActivityPage
            activity={activity!}
            shared={activityShared}
            now={openedAt}
            source={state.draft}
            editable={activityEditable}
            onOpen={onOpenNote ?? (() => {})}
          />
        ) : drawing ? (
          /*
            A drawing gets a drawing editor, never a text editor.

            `LiveEditor` would happily open a `.excalidraw.md` file — it is
            Markdown — and hand somebody a buffer of LZ-String base64 with a
            caret in it. One stray keystroke in that buffer and a save writes
            a payload no reader can decompress: the diagram is gone, and the
            file still looks like a file. So this branch comes before the
            editor rather than beside it, and there is no way past it.

            What `DrawingEditor` is depends on the platform, and each half
            says why in its own header: on web it is Excalidraw itself, loaded
            on demand; on native it is the read-only view, because the editor
            is React DOM and the `WebView` route that would carry it is not
            built yet. Both write through `serializeDrawing`, which splices
            rather than regenerates — the same rule `toolWriteNote` enforces
            against an agent, reached from the other side of the product.
          */
          <DrawingEditor
            path={state.path!}
            source={state.draft}
            canEdit={canEdit}
            /*
              A save goes through the same draft the rest of this screen
              writes, so a drawing is saved by the console's ordinary autosave
              and conflict handling rather than by a path of its own.

              `onChange` unwrapped, not `frontmatter + next` as the compact
              branch below does for `LiveEditor`: that split exists because
              the editor there is handed only the body, and this one is handed
              `state.draft` — the whole file — and returns the whole file.
              Adding the frontmatter back would write it twice.
            */
            onChange={onChange}
            /*
              The room this canvas is shared with, when there is one. Absent
              on the demo console and on a drawing nobody else has open, and
              the editor is then exactly what it was before collaboration
              existed — including an undo that behaves the ordinary way.
            */
            collaboration={drawingCollaboration}
          />
        ) : passphraseLocked ? (
          <LockedNoteView
            path={state.path!}
            stored={state.draft}
            etag={state.etag}
            canEdit={canEdit}
            controller={encryption!.controller}
            onWritten={encryption!.onWritten}
          />
        ) : (
        <>
        {/*
          Who else is in this note, over the note rather than in the console's
          top bar.

          The bar belongs to the console and stays put while notes come and
          go; this is a fact about the note in front of you and leaves with
          it. It draws nothing when nobody else is here, which is almost
          always, so the ordinary editor is unchanged — see `PresenceChip`.
        */}
        {presence === undefined ? null : (
          <View style={styles.presenceRow}>
            <PresenceChip presence={presence} />
          </View>
        )}
        <LiveEditor
          /*
            The body alone on a phone, and the whole file everywhere else.

            **The file is not changed by this.** `frontmatter` is the exact
            prefix `splitNote` removed, so re-attaching it on every edit
            reassembles the original bytes — `frontmatter + body === draft`
            holds for every input by construction, which is the property
            `frontmatter.ts` is built around and `frontmatter.test.ts` asserts
            over a table. A save writes `state.draft` untouched, exactly as it
            always did.

            It also does not fight either editor — and on native there is now
            an editor to not fight. Both write an incoming `value` into
            themselves only when it differs from what they already hold, and
            after a keystroke it does not — the parent re-splits the very
            draft the editor just produced. No dispatch, so no caret jump.

            **A phone gets the body; a pointer layout gets the file.** That
            asymmetry is deliberate and it is about *editing*, not about
            room. `Properties` above changes a value one line at a time, but
            only the lines it can draw faithfully — a nested map or a list is
            still the editor's — so handing the editor the body at a pointer
            density would take those away on the one surface that had them.
            
            What the pointer layout does instead is hide the block until the
            caret is in it (`livePreview.ts`, `frontmatterHidden`), which is
            the same live-preview rule every other mark follows: out of the
            way while you read, there the moment you go to it.
          */
          value={bodyOnly ? body : state.draft}
          editable={editable}
          presence={presence}
          /*
            The accessory bar's keys go out through *this* `onChange`, which
            is the whole reason they are the editor's own commands rather than
            string surgery in the bar itself: pressing B on a phone has to
            re-attach the frontmatter exactly as typing a character does.
            `noteAccessory.test.ts` presses B and asserts the YAML block is
            still in front of what arrives.
          */
          onChange={bodyOnly ? (next) => collaborativeChange(frontmatter + next) : collaborativeChange}
          onVersionedChange={
            collaborativeVersionedChange === undefined
              ? undefined
              : (next, base) =>
                  collaborativeVersionedChange(
                    bodyOnly ? frontmatter + next : next,
                    base,
                  )
          }
          documentRevision={presence?.collaboration?.revision}
          onSave={onSave}
          controls={(api) => {
            controls.current = api;
          }}
          /*
            A press takes the caret; a swipe hands it straight back.

            See `moving`/`settledAt` above: on native the editable surface
            *is* the document, so scrolling the note focuses it and the app
            answered a reader's swipe by opening an editor. `blur()` is
            `EditorControls`' own, so the caret is released the way every
            other command reaches the editor — over the bridge, rather than
            by this file reaching for a native input it no longer has.
          */
          onFocus={() => {
            if (moving.current || Date.now() - settledAt.current < SCROLL_GRACE_MS) {
              controls.current?.blur();
              return;
            }
            setFocused(true);
            // The native editor says focus and nothing finer, so there the
            // whole of a focused editor counts as "in the title": a title
            // renames its file when the keyboard goes away, not at every
            // pause in typing it. The web editor reports the caret itself.
            if (Platform.OS !== "web") onTitleCaret?.(true);
          }}
          onBlur={() => {
            setFocused(false);
            if (Platform.OS !== "web") onTitleCaret?.(false);
          }}
          onTitleCaret={onTitleCaret}
          titleNote={titleNote}
          /*
            The caret went under the keyboard and the editor cannot reach it.
            Compact only, because the editor scrolls itself everywhere else —
            passing it there would be a page scroller moving underneath an
            editor that had already handled the same problem.
          */
          onScrollBy={
            compact
              ? (delta) =>
                  scroller.current?.scrollTo({ y: offset.current + delta, animated: true })
              : undefined
          }
          accessibilityLabel={`${state.path} markdown`}
          notePath={state.path}
          notePaths={notePaths}
          /*
            A click and a tap go to the note; a ⌘-click opens it behind. The
            asymmetry is the gesture's, not the destination's — see
            `noteLinks.ts`. Absent when the caller gave us nowhere to go,
            which is what stops the editor underlining text it cannot act on.
          */
          onOpenNote={onOpenLink === undefined ? undefined : onOpenLink}
          onSuggest={onSuggest}
          onPickSuggestion={onPickSuggestion}
          /*
            The two voice rows on the note's right-click menu. Absent where
            there is nothing behind them — no voice host is no microphone,
            and no `onAskAgent` is no right panel — and `editorMenuItems`
            then draws no row rather than one that does nothing.

            The caret the menu was opened at is deliberately dropped: the
            dictation this starts inserts at the live caret, which the menu
            has already moved to the click (see `LiveEditor.web.tsx`), so
            carrying the number would be a second answer to a question that
            is already settled.
          */
          onDictate={voice === null ? undefined : () => setDictateAsked(Date.now())}
          onAsk={voice?.onAskAgent ?? undefined}
          onPreviewLinks={onPreviewLinks}
          onSubmitForm={onSubmitForm}
          onReadFormResponses={onReadFormResponses}
          onVoteForm={onVoteForm}
          onUpdateFormResponse={onUpdateFormResponse}
          onRetractFormResponse={onRetractFormResponse}
          onLoadImage={onLoadImage}
          onStoreImage={onStoreImage}
          onImageProblem={onImageProblem}
          folderLists={folderLists}
        />
        </>
        )}
      </View>
  );
}
