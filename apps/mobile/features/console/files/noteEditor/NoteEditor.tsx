import { useEffect, useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useFrame } from "../../../app/AppFrame";
import { useSurfacePadding } from "../../../app/Screen";
import { densityFor } from "../../../app/frame";
import { useThemedStyles } from "../../../design/theme";
import { accessoryUp } from "../accessory";
import { saveButton } from "../editor";
import { noteHeadingSource, splitNote } from "../frontmatter";
import { isDrawingPath } from "@context/drawings";
import { ACTIVITY_PATH } from "../../activity/activity";
import { isPassphraseNote } from "../../encryption/envelope";
import type { EditorControls } from "../LiveEditor";
import { NoteAccessory } from "../NoteAccessory";
import { useVoiceHost } from "../../../voice/VoiceHost";
import { makeStyles } from "./styles";
import { noteFoot } from "./statusLine";
import { PublishOpenNote } from "./PublishOpenNote";
import { noteFlow } from "./flow";
import { noteScroller } from "./scroller";
import { noteVoiceButton } from "./voice";
import type { NoteEditorProps } from "./props";
import type { NoteView } from "./view";

/**
 * The note itself: markdown, drawn as the document it is.
 *
 * This used to say "not a WYSIWYG, on purpose", and the reasoning it gave is
 * still exactly right — the canonical thing in this product is a markdown file
 * the customer owns and also opens in Obsidian, and **an editor that renders
 * something other than the file is an editor that can disagree with it.**
 *
 * What changed is that the rule no longer implies a plain textarea. `LiveEditor`
 * on web is CodeMirror in Obsidian's Live Preview mode: the buffer *is* the
 * markdown, styled where it sits, with the markup hidden only while the cursor
 * is elsewhere. Nothing parses the document into another model and serializes it
 * back, so there is no serializer that could disagree with the file — the
 * property this comment was protecting is stronger now, not weaker. A block
 * editor (Yoopta, TipTap) would have broken it, which is why this is not one.
 *
 * On native it is the same editor. CodeMirror is a DOM library, so `LiveEditor.tsx`
 * runs it inside a `WebView` over a five-message JSON bridge — one editor
 * configuration (`editorSetup.ts`), two hosts, one bundle committed and shipped
 * with the app so a note opens with no network at all. This comment used to say
 * the native half was a textarea and that the gap was deliberate; see
 * `LiveEditor.tsx` for which halves of that argument expired and which one
 * (a `TextInput` cannot hide a range of its own value) is why it is a web view
 * rather than a second editor.
 *
 * Read-only notes (`privacy.md`, and the whole landing-page demo) render as the
 * mockup's tinted preview rather than a disabled editor, because a disabled
 * editor looks broken and a preview looks deliberate.
 *
 * The preview keeps its monospace face at every width, and that is not an
 * oversight in the phone layout beside it: `LiveEditor` grows to reading type
 * on a phone because the thing on screen is a *note*, and the two documents
 * that reach this branch are `privacy.md` — a generated config file, where the
 * mono face is the whole signal that it is one — and the landing page's demo,
 * which is a picture of the console rather than somebody's reading surface.
 * What the preview does drop on a phone is its *box*, for the same reason the
 * editor drops its own: a border around the only thing on the glass.
 *
 * ## The keyboard accessory bar, and the three conditions it appears under
 *
 * While the keyboard is up on a phone it covers the bottom bar, so the app has
 * no controls at all — including no way to put the keyboard away, because the
 * editor is a `WebView` with its outer scroller switched off and there is no
 * drag-to-dismiss to fall back on. `NoteAccessory` is the answer, and
 * `accessoryUp` holds the three conditions it renders under; the same call
 * decides how much of the note `LiveEditor` has to keep clear for it.
 *
 * ## And the frontmatter, which is split for display and never for storage
 *
 * A captured note opens with a dozen lines of YAML, and this editor draws the
 * file, so on a phone that block *is* the first screen. The editor is therefore
 * handed the body alone at `compact`, and the exact prefix `splitNote` removed
 * is put back in front of every edit before it reaches `onChange`.
 * `frontmatter + body === draft` holds for every input by construction — which
 * is what makes a save return the file byte for byte — and it holds for a key
 * on the accessory bar exactly as for a keystroke, because a command's effect
 * leaves `LiveEditor` through the same `onChange`.
 */
export function NoteEditor({
  state,
  presence,
  drawingCollaboration,
  canEdit,
  reading = false,
  visibility,
  notices,
  pathBar,
  onChange,
  onSave,
  onDiscard,
  onUseTheirs,
  onKeepMine,
  onOpenLink,
  notePaths,
  onSuggest,
  onPickSuggestion,
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
  encryption,
  activity,
  activityShared = false,
  activityEditable = false,
  onOpenNote,
}: NoteEditorProps) {
  const styles = useThemedStyles(makeStyles);
  /*
    Reading mode joins the two reasons a note was already not editable — no
    write access, and a note this door never writes (`privacy.md`, an encrypted
    envelope). It is deliberately the same `editable` rather than a mode of its
    own: everything downstream of this flag is already correct for "you are not
    typing into this", from `contenteditable` to the paste and drop handlers
    `editorSetup`'s `editability` turns off, and a parallel flag would be a
    second answer for those to disagree about.

    It arrives as a prop rather than being read from the router here. This
    component takes what it draws and reaches for nothing — calling
    `useReadMode` inside it put `expo-router` into the dependency graph of
    every test that mounts a note, and 35 of them stopped at a mock that had
    never needed it. `BrowsePane` owns the route's half of this.
  */
  /*
    THE ONE PATH WHERE WRITING IS NARROWER THAN `canEdit`.

    `activity.md` is the context's record of who changed what, so editing it by
    hand is editing that record — the owner's authority, not an editor's. The
    rule is `canEditActivity`'s and lives in `capabilities.ts` for the reason
    that file's header gives at length: every console guard written inline in a
    component survived a full sabotage sweep untouched.

    The server refuses the rest anyway — the file is private, so a member or an
    editor cannot read it, let alone write it — which makes this the affordance
    and not the guard. A pencil that leads to a refusal is worse than no pencil.
  */
  const durableReady = presence?.collaboration?.ready !== false;
  const editable =
    canEdit &&
    durableReady &&
    !state.readOnly &&
    !reading &&
    !(state.path === ACTIVITY_PATH && !activityEditable);
  /*
    A passphrase note is `state.encrypted` exactly as a workspace-encrypted
    one is — the flag does not (and must not) say which recipient locked it,
    since that is a question only the envelope itself answers. This is the
    one place that asks: `isPassphraseNote` reads `state.draft`, which for an
    encrypted note is its ciphertext (`editorReducer`'s `opened` case sets
    `draft` to the stored text unchanged), so this is answered from bytes
    already in hand rather than a second read.
  */
  const passphraseLocked =
    state.encrypted && encryption !== undefined && isPassphraseNote(state.draft);
  /*
    A drawing is decided by its path, never by its content: the check has to
    hold for a file that is still loading, for one whose payload is unreadable,
    and for an empty draft — and in every one of those the path is the only
    thing that is known. An encrypted drawing stays on the locked path below,
    because there is nothing to draw until it is opened.
  */
  const drawing = !passphraseLocked && !state.encrypted && isDrawingPath(state.path ?? "");
  /*
    Decided by path, exactly as a drawing is, and for the same reason: it has
    to hold for a file that is still loading and for one whose body has not
    arrived. Only where the console actually has the list — a demo console, or
    one whose read was refused, opens the file as the note it is, which is the
    honest fallback rather than an empty screen.
  */
  const isActivityNote = !passphraseLocked && activity !== undefined && state.path === ACTIVITY_PATH;
  /**
   * The activity file drawn as the list rather than as its Markdown.
   *
   * **A default, not a lock.** `viewMode.ts` declares `read` for this path when
   * it opens, so a person lands on the list; pressing the pencil makes it
   * editable and this goes false, and they get the same editor every other note
   * has, over the same file, machine comments and all. That is the difference
   * between a page that defaults to being read and a page the product will not
   * let you touch — and it is the whole point: what makes the file yours is
   * being able to open it.
   */
  const activityList = isActivityNote && !editable;
  /**
   * The moment this screen was opened, for every relative time on it.
   *
   * A `useState` initialiser rather than `Date.now()` in the body: re-reading
   * the clock on every render makes "4 min" change under a scroll, and makes
   * two rows rendered in one pass disagree about what "today" is.
   */
  const [openedAt] = useState(() => Date.now());
  const button = saveButton(state);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  // A collaborative binding owns the whole Y.Text, including frontmatter.
  // Slicing its display or prefixing an edit would change shared coordinates.
  const bodyOnly = compact && presence?.collaboration === undefined;
  const collaborativeChange = presence?.collaboration?.onChange ?? onChange;
  const collaborativeVersionedChange = presence?.collaboration?.onVersionedChange;
  /*
    The accessory bar's two inputs. `focused` is state because it decides what
    renders; the handle is a ref because it decides nothing — re-rendering the
    whole note the moment the editor hands its commands over would be a render
    for no visible change, on the mount that is already the most expensive one.
  */
  const [focused, setFocused] = useState(false);
  /**
   * When the right-click menu last asked for the microphone, or `null`.
   *
   * Held here rather than in `LiveEditor` because the microphone belongs to
   * `VoiceButton`, which is this component's child — so this is the one place
   * that can see both the menu and the control it reaches.
   */
  const [dictateAsked, setDictateAsked] = useState<number | null>(null);
  /**
   * How wide the document column is, so the Properties row can start where the
   * note's first character does.
   *
   * `0` until the first layout, which `noteGutterFor` floors to the plain
   * gutter — the same answer as a window too narrow for the measure, so the
   * first frame is never wrong in a direction anybody sees.
   */
  const [docWidth, setDocWidth] = useState(0);
  const controls = useRef<EditorControls | null>(null);
  const frame = useFrame();
  const padding = useSurfacePadding();
  const barUp = accessoryUp({ compact, editable, focused });
  const voice = useVoiceHost();
  /**
   * The note is the editable document, rather than a drawing or an envelope.
   *
   * Read off the same two conditions the render below branches on, in the same
   * order, so "is the editor on screen" and "what is on screen" cannot come
   * apart — the failure that costs is the silent one where they disagree and a
   * floating control hangs over a surface nobody tested it against.
   */
  /*
    `activityList` is the third exclusion, and it was missing: #739 put the
    activity list in front of the editor without adding it here, so a floating
    microphone was drawn over a list with no caret under it — inert, and on a
    phone sitting over the page's own foot. The rule this comment already
    states ("read off the same two conditions the render below branches on, in
    the same order") is what catches that, and it only catches it when the list
    is actually one of the conditions.
  */
  const liveEditorOnScreen = !activityList && !drawing && !passphraseLocked;

  /**
   * Whether the note is moving, and when it last came to rest — the whole of
   * "a scroll gesture is not an edit intent".
   *
   * **Swiping to read put the note into editing.** The editable surface at this
   * density *is* the document, so a swipe hands the pan to this scroller and
   * then hands the caret to the editor. Measured while `LiveEditor` on native
   * was still a `TextInput`; the surface is a `WebView` now and the rule is
   * unchanged, because what raises the bar is the focus that arrives and not
   * which half reported it. The formatting
   * bar came up, the frame put its own toolbar away, and there was no way to
   * read a long note to the end without being dropped into an editor nobody had
   * asked for. `onFocus` below refuses a caret that arrives this way.
   *
   * **Two signals, because one of them is not enough anywhere.** Measured on an
   * iPhone 16 Pro Max, with `Date.now()` alongside each event of one swipe:
   *
   *     touchStart 738867 · beginDrag 738894 · touchEnd 739523 ·
   *     endDrag 739525 · focus 740215 · momentumEnd 740216
   *
   * The focus lands **690ms after the finger lifts** and one millisecond before
   * the fling stops — so a window measured from the last scroll event misses it
   * by a wide margin, which is exactly how the first attempt at this fix passed
   * its test and changed nothing on the device. What the focus *is* inside is
   * the gesture: `moving` runs from `onScrollBeginDrag`/`onMomentumScrollBegin`
   * to `onScrollEndDrag`/`onMomentumScrollEnd`, and it was true throughout.
   *
   * `settledAt` is the second signal and covers the two cases `moving` cannot:
   * a slow drag that ends with no fling at all, where the focus arrives just
   * after `onScrollEndDrag`; and the web, where react-native-web's `ScrollView`
   * forwards `onScroll` and none of the drag events, so a scroll event is the
   * only mark there is. `SCROLL_GRACE_MS` is that window.
   *
   * Refs rather than state: nothing on screen depends on either, and a render
   * per scroll event on the app's most expensive mount is not a price worth
   * paying for values only a callback reads.
   */
  const moving = useRef(false);
  const settledAt = useRef(0);
  /**
   * The page scroller and where it is, so the editor can ask it to move.
   *
   * At compact the web view is laid out at its document's full height — see
   * `LiveEditor`'s `height` — which is what makes this one scroller rather than
   * two, and which also means CodeMirror can no longer scroll the caret clear of
   * the keyboard for itself. `onScrollBy` below is how it asks this one to.
   *
   * The offset is a ref read from the scroll events already being listened to
   * for the swipe guard: `scrollTo` takes an absolute position, so the delta has
   * to be added to something, and a render per scroll event to keep it in state
   * is the price this component already refuses to pay.
   */
  const scroller = useRef<ScrollView | null>(null);
  const offset = useRef(0);
  /*
    The note's find bar, into Escape's reach.

    ⌘F opens a bar over the document (`findInNote.ts`), and CodeMirror's own
    Escape only reaches it while the caret is in the note or in the query
    field. Click a tree row, a tab or the accessory bar and the key goes to the
    console's `dismiss` command instead — `frame.closeOverlays()`, which knows
    about the panels the frame renders and knew nothing about this one. That is
    the whole of "isn't dismissable", and this is the registration that answers
    it.

    Through the ref, never a captured handle: the bar this closes is whichever
    editor is mounted at the moment Escape is pressed, and the handle arrives
    after this effect has already run. `closeFind` is web-only and optional, so
    on a phone this closer answers `false` and Escape falls through exactly as
    it did.
  */
  const { registerDismissable } = frame;
  useEffect(
    () => registerDismissable(() => controls.current?.closeFind?.() ?? false),
    [registerDismissable],
  );

  /*
    Tell the frame while the accessory bar is up, so it puts its own toolbar
    away. Two floating bars in the same 66pt of glass is worse than either, and
    the reference has no bottom bar in its editing screenshot — while the
    keyboard is up, this row *is* the toolbar.

    It has to be the frame that hides it rather than this bar painting over it:
    the two live in different stacking contexts (this is inside the editor
    region, the toolbar is a sibling of it), so no `zIndex` either of them asks
    for can order them against each other.
  */
  const { setAccessoryOpen } = frame;
  useEffect(() => {
    setAccessoryOpen(barUp);
    // Leaving the note with the keyboard up — closing a tab, switching context
    // — must not leave the frame believing a bar is on screen that unmounted
    // with it.
    return () => setAccessoryOpen(false);
  }, [barUp, setAccessoryOpen]);
  /*
    Split for display, never for storage. `frontmatter` is put back in front of
    every edit before it reaches `onChange`, so what is saved is the file that
    was opened — see the `LiveEditor` call below.
  */
  const { frontmatter, body } = splitNote(state.draft);
  /*
    Whether to draw the inline title at all.

    When the note is named by its own opening `# H1`, that heading is already on
    screen inside the document, and drawing the title too shows the same string
    twice on the first screen. Suppressing the title rather than stripping the
    heading is deliberate: on a phone `body` below is the editor's *buffer*, so
    removing a line from it would delete that heading from the file on save.
  */
  const titled = noteHeadingSource(state.draft, state.path) !== "heading";

  // The line at the foot of the document, and whether anything belongs down
  // there at all — see `noteFoot`, which carries the whole rule.
  const { durability, canDiscard, explains, manualSave } = noteFoot({ state, presence, editable, compact, button });

  const view: NoteView = {
    // Props, as destructured above.
    state, presence, drawingCollaboration, canEdit, reading, visibility, notices, pathBar,
    onChange, onSave, onDiscard, onUseTheirs, onKeepMine, onOpenLink, notePaths, onSuggest,
    onPickSuggestion, onPreviewLinks, onSubmitForm, onReadFormResponses, onVoteForm,
    onUpdateFormResponse, onRetractFormResponse, onLoadImage, onStoreImage, onImageProblem,
    folderLists, encryption, activity, activityShared, activityEditable, onOpenNote,
    // Derived above, in the order the hooks require.
    styles, editable, passphraseLocked, drawing, activityList, openedAt, button, compact,
    bodyOnly, collaborativeChange, collaborativeVersionedChange, setFocused, dictateAsked,
    setDictateAsked, docWidth, setDocWidth, controls, padding, barUp, voice, moving, settledAt,
    scroller, offset, frontmatter, body, titled, durability, canDiscard, explains, manualSave,
  };

  /**
   * Everything that scrolls, as one node.
   *
   * Built here rather than written twice because the *container* is what
   * differs between the two densities and nothing inside it does: a phone puts
   * this in a scroller that runs the full height of the glass, a pointer layout
   * lets the region hold it and the editor scroll itself. Two copies of this
   * tree is how a control ends up on one surface and missing from the other.
   */
  const flow = noteFlow(view);

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      {/*
        One full-bleed scroll surface on a phone, and the chrome paid for in
        content padding at both ends.

        The top bar and the toolbar both lie *over* this, so the document runs
        from the top of the glass to the bottom and spends
        `FrameApi.contentInsets` inside its own content instead of shortening
        the viewport. That is what lets the inline title be scrolled out from
        under the toggle, the last line out from under the pill, and everything
        between pass behind them — which is what the reference does and what a
        viewport-sized scroller can never do. `scrollIndicatorInsets` matches,
        so the bar does not run under the chrome either.

        A pointer layout hands the flow straight to the region: the editor there
        scrolls itself inside a window that has a real toolbar above it, and a
        page scroller around it would be a second scrollbar around the first.
      */}
      {compact ? (
        noteScroller(view, flow)
      ) : (
        flow
      )}

      {/*
        Outside the scroller, and that is load-bearing rather than tidy.

        `KeyboardSticky` positions this absolutely against its parent, so inside
        a `ScrollView`'s content it would anchor to the bottom of the *document*
        and scroll away with it. As a sibling of the scroller it anchors to the
        region and rides above the keyboard, which is the whole job.

        See `accessory.ts` for the three conditions it appears under, and
        `LiveEditor.tsx` for why this bar is the only way out of the keyboard
        rather than one of two.
      */}
      {barUp ? <NoteAccessory controls={() => controls.current} /> : null}

      {/*
        The microphone, anchored to the region for the same reason the bar
        above it is: inside the scroller it would ride the document.

        Mounted here rather than in the console layout because this is the one
        component that holds the live `EditorControls` — the same handle the
        accessory bar takes, and taken the same way, as a getter that answers
        `null` between notes. Everything it needs that the editor does not know
        (which context, whose note, how to start a meeting) arrives through
        `useVoiceHost`, which is `null` on the demo console and the fixtures so
        they draw nothing.

        **`liveEditorOnScreen` is the whole condition**, and it is the editor's
        own branch rather than a list of exclusions. A drawing is an Excalidraw
        canvas with no caret; a locked note is an envelope with a passphrase
        field where the editor would be. Neither has a `controls` handle, so the
        button would be inert — and inert is the *better* half of what went
        wrong. It is `position: absolute` at this corner, so on a phone it also
        lay over `LockedNoteView`'s own Save button and swallowed its presses.
        WebKit CI found that, in `encryption.spec.ts`, not in a test of this
        feature: a floating control is every other control's problem.
      */}
      {/*
        What is open, published for the console's right panel.

        `NoteEditor` is the only thing that can build this — `page.ts` argues
        that where `noteReference` is defined — and the panel is its sibling
        rather than its descendant, so the two meet at a store rather than at
        a provider hoisted over both. See `features/agent/openNote.ts`.

        Drawn as a component rather than run as an effect here so that it
        unmounts with the editor: leaving a stale note published after the
        pane goes would have the panel describing a room nobody is in.
      */}
      <PublishOpenNote state={state} />

      {voice === null || !liveEditorOnScreen ? null : (
        noteVoiceButton(view, voice)
      )}
    </View>
  );
}
