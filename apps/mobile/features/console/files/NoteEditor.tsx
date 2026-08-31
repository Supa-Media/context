import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFrame } from "../../app/AppFrame";
import { useSurfacePadding } from "../../app/Screen";
import { densityFor } from "../../app/frame";
import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { describe as describeVisibility } from "./Breadcrumb";
import { saveButton, type EditorState } from "./editor";
import { noteHeading, noteHeadingSource, properties, splitNote, type Property } from "./frontmatter";
import { LiveEditor, type EditorControls } from "./LiveEditor";
import { NoteAccessory } from "./NoteAccessory";
import { highlightMarkdown } from "./highlight";
import type { Visibility } from "./types";

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
 * On native `LiveEditor` is the textarea this always was. CodeMirror is a DOM
 * library and the alternatives are worse than the gap; see `LiveEditor.tsx`.
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
 * no controls at all — including no way to put the keyboard away. `NoteAccessory`
 * is the answer, and it renders only when all three of `compact`, `editable`
 * and `focused` hold. Each of those is load-bearing rather than defensive:
 *
 *  - **`compact`** — a pointer has a real keyboard and the chords that go with
 *    it, and a floating toolbar over a desktop editor is chrome nobody asked
 *    for. A phone has neither route.
 *  - **`editable`** — every key on the bar writes to the note. On `privacy.md`,
 *    or in a context somebody was invited into as a reader, they would all fail;
 *    a bar of controls that cannot do anything is worse than no bar.
 *  - **`focused`** — the bar rides above the keyboard, and there is no keyboard
 *    until this surface has the caret. It comes from the editor's own
 *    `onFocus`/`onBlur` rather than from the keyboard's visibility, because the
 *    keyboard can be up over a completely different screen.
 */
export function NoteEditor({
  state,
  canEdit,
  visibility,
  notices,
  onChange,
  onSave,
  onDiscard,
  onUseTheirs,
  onKeepMine,
}: {
  state: EditorState;
  canEdit: boolean;
  /**
   * Who can read this note, as the access map answers it — a Properties row.
   *
   * `visibility:` is filing metadata about a note, which is exactly what the
   * Properties panel is for, and it is where the breadcrumb's chip went when
   * the breadcrumb went. The value comes from the *manifest* rather than from
   * the file's own frontmatter, because a `visibility:` line inside a note
   * decides nothing — `privacy.md` does, which is what `ManifestNotice` says in
   * so many words. So a note carrying its own `visibility:` has that row
   * replaced by this one rather than showing two answers to one question.
   *
   * Optional, and absent everywhere but the console's Browse pane: a
   * `NoteEditor` mounted without an entry beside it has no honest answer, and
   * inventing "private" would be a claim about access made by a component that
   * was not told.
   */
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  };
  /**
   * What the pane has to say about this note, inside the note's own scroller.
   *
   * A prop rather than a sibling above this component, because on a phone that
   * scroller is the screen: a notice rendered outside it would be a band pinned
   * across the top of the glass under chrome that is already floating there,
   * and the note would start below it instead of running behind it. Passed as a
   * node because what the notices *say* is the pane's business — a bucket that
   * is not connected, a privacy manifest that will not parse — and none of it
   * is the editor's.
   */
  notices?: ReactNode;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onUseTheirs: () => void;
  onKeepMine: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const editable = canEdit && !state.readOnly;
  const button = saveButton(state);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  /*
    The accessory bar's two inputs. `focused` is state because it decides what
    renders; the handle is a ref because it decides nothing — re-rendering the
    whole note the moment the editor hands its commands over would be a render
    for no visible change, on the mount that is already the most expensive one.
  */
  const [focused, setFocused] = useState(false);
  const controls = useRef<EditorControls | null>(null);
  const frame = useFrame();
  const padding = useSurfacePadding();
  const accessoryUp = compact && editable && focused;
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
    setAccessoryOpen(accessoryUp);
    // Leaving the note with the keyboard up — closing a tab, switching context
    // — must not leave the frame believing a bar is on screen that unmounted
    // with it.
    return () => setAccessoryOpen(false);
  }, [accessoryUp, setAccessoryOpen]);
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
  const titled = noteHeadingSource(state.draft) !== "heading";

  /**
   * Everything that scrolls, as one node.
   *
   * Built here rather than written twice because the *container* is what
   * differs between the two densities and nothing inside it does: a phone puts
   * this in a scroller that runs the full height of the glass, a pointer layout
   * lets the region hold it and the editor scroll itself. Two copies of this
   * tree is how a control ends up on one surface and missing from the other.
   */
  const flow = (
    <>
      {compact ? notices : null}
      {state.readOnly ? <ManifestNotice /> : null}

      {/*
        The note's name, inside the note — Obsidian's inline title.

        It is the first thing in the document rather than a line of chrome above
        it, which is the whole point: it scrolls with the text and passes under
        the floating toolbar exactly as the first paragraph does. A path pinned
        above the document was the second of the two bands this branch exists to
        collapse, and it named the note *worse* — at three segments and a chip
        the line ellipsised at both ends on a 390pt screen.

        `noteHeading` decides what a note is called: its frontmatter's `title`
        or `subject`, then the body's own `# Heading`, then the filename. A
        captured note's filename is a content hash, which is the case that
        argument exists for.

        Compact only. A pointer layout still has the breadcrumb, which carries
        folder navigation this cannot, and two names above one note is worse
        than either.

        And `titled` only: when the name came from the body's own `# H1`, that
        heading is already on screen and drawing it here too shows one string
        twice on the first screen. The heading stays and the title steps aside,
        rather than the other way round — `body` below is the editor's buffer on
        a phone, so removing a line from it would delete it from the file.
      */}
      {/*
        `state.path` is `null` only for the empty editor, which this pane never
        renders — `BrowsePane` draws `Empty` instead. Guarded rather than
        asserted, because a heading row with nothing in it reads as a broken
        screen and `noteHeading` refuses to invent one.
      */}
      {compact && state.path !== null && titled ? (
        <Text
          role="heading"
          aria-level={1}
          style={styles.inlineTitle}
          testID="note-inline-title"
        >
          {noteHeading(state.draft, state.path)}
        </Text>
      ) : null}

      {/*
        **A note you cannot edit is still a note.**

        This used to branch on `editable`: anything read-only fell through to
        the syntax-highlighted source below — monospace, with its `#` and `**`
        showing. That is a reasonable *inspector*, and it was reaching people it
        was never meant for. `browser.ts` is explicit that `canEdit: false` is a
        signed-in workspace **member**, not a landing-page visitor, so every
        note in a context somebody was invited into was read as raw Markdown in
        a code face on a phone.

        The reading surface is the same one, with editing switched off:
        `LiveEditor` already takes `editable`, CodeMirror's own `contenteditable`
        goes with it, and the live-preview decorations do not care. So a member
        reads what an editor reads, which is what Obsidian's reading view is.

        The source view survives where it earns its keep — a pointer, where the
        window is wide enough to inspect a file beside the tree that names it,
        and where `previewContentCompact` was never the layout anyway.
      */}
      {editable || compact ? (
        <View style={compact ? undefined : styles.document}>
          {/*
            The filing metadata, folded away — see `Properties` below and
            `frontmatter.ts`. Drawn where there is a block to fold **or** an
            access-map answer to state; a note with neither gets no row at all
            rather than an empty disclosure.
          */}
          {compact && (frontmatter !== "" || visibility !== undefined) ? (
            <Properties frontmatter={frontmatter} visibility={visibility} />
          ) : null}
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

              It also does not fight CodeMirror on web. That editor writes an
              incoming `value` into itself only when it differs from what it
              already holds, and after a keystroke it does not — the parent
              re-splits the very draft the editor just produced. No dispatch, so
              no caret jump.
            */
            value={compact ? body : state.draft}
            editable={editable}
            onChange={compact ? (next) => onChange(frontmatter + next) : onChange}
            onSave={onSave}
            /*
              The accessory bar's keys go out through *this* `onChange`, which
              is the whole reason they are the editor's commands rather than
              string surgery in the bar itself: pressing B on a phone has to
              re-attach the frontmatter exactly as typing a character does.
              `noteAccessory.test.ts` presses B and asserts the YAML block is
              still in front of what arrives.
            */
            controls={(api) => {
              controls.current = api;
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel={`${state.path} markdown`}
          />
        </View>
      ) : (
        <ScrollView
          style={[styles.preview, compact && styles.previewCompact]}
          contentContainerStyle={compact ? styles.previewContentCompact : styles.previewContent}
        >
          <Text variant="code">
            {highlightMarkdown(state.draft).map((span, index) => (
              <Text
                key={index}
                variant="code"
                style={
                  span.tone === "key"
                    ? styles.codeKey
                    : span.tone === "heading"
                      ? styles.codeHeading
                      : undefined
                }
              >
                {span.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      )}

      {state.status === "conflict" ? (
        <View style={styles.conflict}>
          <Text variant="hint" style={styles.conflictText}>
            {state.message} Your draft is still here — nothing has been overwritten.
          </Text>
          <View style={styles.conflictActions}>
            <Button label="Load theirs" onPress={onUseTheirs} />
            <Button label="Keep mine" onPress={onKeepMine} />
          </View>
        </View>
      ) : null}

      {/*
        On a phone this line appears only when it has something to say.

        Under a pointer it is the foot of the region and "Saved in your bucket"
        is a reassurance worth a permanent 26pt strip. On a phone the region is
        the whole glass and the chrome floats over it, so a permanent strip is a
        band of chrome across the bottom of a note that already has a toolbar
        lying on it — and the toolbar's own Save already carries the dirty dot,
        which is the same fact in the place a thumb is.

        What survives is the case the line exists for: an unsaved draft, and the
        Discard beside it. Discard has no other route on a phone (the row menu
        acts on a file in the tree; this acts on the draft in front of you), so
        it appears exactly when there is something to discard.
      */}
      {editable && (!compact || state.status === "dirty" || state.status === "error") ? (
        <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
          <Text variant="meta" style={styles.status}>
            {statusLine(state)}
          </Text>
          {state.status === "dirty" || state.status === "error" ? (
            <Button label="Discard changes" onPress={onDiscard} />
          ) : null}
          {/*
            Save is on the bottom toolbar on a phone — `check`, which dims when
            there is nothing to save and carries a dot when there is — so
            drawing it again here is two Save buttons on a 390pt screen, one of
            them under the reader's thumb and one not.

            Discard is *not* dropped with it. It has no other route on a phone:
            the row menu acts on a file in the tree, and this acts on the draft
            in front of you. A control removed because its neighbour was
            duplicated is a capability lost to a layout decision.
          */}
          {compact ? null : (
            <Button
              label={button.label}
              variant={state.status === "conflict" ? "danger" : "white"}
              disabled={button.disabled}
              onPress={onSave}
            />
          )}
        </View>
      ) : null}
    </>
  );

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
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingTop: padding.top, paddingBottom: padding.bottom }}
          scrollIndicatorInsets={{ top: padding.top, bottom: padding.bottom }}
          testID="note-scroll"
        >
          {flow}
        </ScrollView>
      ) : (
        flow
      )}

      {/*
        Outside the scroller, and that is load-bearing rather than tidy.

        `KeyboardSticky` positions this absolutely against its parent, so inside
        a `ScrollView`'s content it would anchor to the bottom of the *document*
        and scroll away with it. As a sibling of the scroller it anchors to the
        region and rides above the keyboard, which is the whole job. See the
        file comment for the three conditions it appears under.
      */}
      {accessoryUp ? <NoteAccessory controls={() => controls.current} /> : null}
    </View>
  );
}

/**
 * The note's filing metadata, folded away.
 *
 * A captured note opens with a dozen lines of YAML — `captured:`, `source:`,
 * `trust:`, `sender-authenticated-by:` — and the editor draws the file, so on a
 * phone that block *was* the first screen. The note started below the fold. It
 * is not secret and it is occasionally worth reading, so it is collapsed rather
 * than hidden: one quiet row that says how many fields there are, and opens.
 *
 * The same shape Obsidian uses, and for the same reason.
 *
 * ## It is a reader, not a form
 *
 * The values are `Text`, not inputs, and there is nothing here that writes.
 * Editing frontmatter means editing the note, which is what the editor below is
 * for and where the buffer is still the file byte for byte. A property editor
 * would need a YAML *writer*, and `frontmatter.ts` argues at length why this
 * codebase should not have one: a reader that misunderstands a line shows it
 * oddly, and a writer that misunderstands the same line rewrites somebody's
 * note into something they did not type.
 *
 * Collapsed is the resting state on purpose. The whole complaint this answers
 * is that metadata was taking the reader's first screen, and a row that starts
 * open takes it back.
 */
function Properties({
  frontmatter,
  visibility,
}: {
  frontmatter: string;
  /** See `NoteEditor`'s prop of the same name. */
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  };
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const rows = withVisibility(properties(frontmatter), visibility);

  return (
    <View style={styles.properties}>
      <PressRow
        accessibilityLabel={
          open
            ? `Hide this note's ${rows.length} properties`
            : `Show this note's ${rows.length} properties`
        }
        onPress={() => setOpen((current) => !current)}
        radius={radii.sm}
        style={styles.propertiesHead}
        hoverStyle={styles.propertiesHover}
        testID="note-properties"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.muted} />
        <Text variant="treeMeta">
          {/*
            The count is the whole of what the collapsed row has to say. "1
            property" over "1 properties" because a note with a single field is
            common enough — a bare `updated:` — that the ungrammatical form
            would be on screen most days.
          */}
          {rows.length === 1 ? "1 property" : `${rows.length} properties`}
        </Text>
      </PressRow>

      {open ? (
        /*
          Obsidian's panel, drawn from the reference: a rounded, faintly tinted
          card; one row per field with a small leading mark; the key in muted
          ink in a fixed leading column; the value in ordinary ink, wrapping to
          as many lines as it needs. The card is what makes it read as a block
          of *metadata about* the note rather than as the first paragraph of it.
        */
        <View style={styles.propertyCard} testID="note-properties-open">
          {rows.map((row, index) => (
            <View key={`${row.key}-${index}`} style={styles.property}>
              {/*
                Obsidian draws a different mark per property *type* — a
                calendar for a date, lines for text. Frontmatter here has no
                types, so one neutral mark stands for "this row is a labelled
                value" and it is `aria-hidden` because the key beside it is
                already the name.
              */}
              <View style={styles.propertyMark}>
                <Icon name="filter" size={15} color={colors.muted} />
              </View>
              <Text variant="rowSub" style={styles.propertyKey} numberOfLines={1}>
                {row.key}
              </Text>
              <Text variant="rowSub" style={styles.propertyValue}>
                {row.value}
              </Text>
            </View>
          ))}

          {/*
            Obsidian's last row, and ours is deliberately inert.

            Adding a property means *writing* frontmatter, and `frontmatter.ts`
            argues at length why this codebase has a reader and no writer: a
            reader that misunderstands a line shows it oddly, and a writer that
            misunderstands the same line rewrites somebody's note into something
            they did not type. Until there is a writer with a byte-for-byte
            round-trip test behind it, this states where the capability will be
            rather than pretending to have it — and it says so out loud to a
            screen reader, because a control that is present and silently
            refuses is the defect this codebase keeps recording.

            It is drawn rather than dropped because the row is also the honest
            answer to "where do I edit these?" on a phone: the frontmatter is
            not in the editor's buffer at this density (see the `LiveEditor`
            call above), so somebody looking for it needs to be told, not left
            to conclude it is gone.
          */}
          <View style={[styles.property, styles.propertyAdd]} aria-disabled testID="note-properties-add">
            <View style={styles.propertyMark}>
              <Icon name="plus" size={15} color={colors.muted} />
            </View>
            <Text
              variant="rowSub"
              style={styles.propertyAddLabel}
              accessibilityLabel="Add a property. Not available yet — edit this note's frontmatter from a desktop browser or in Obsidian."
            >
              Add property — from a desktop, for now
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The frontmatter's rows, with the one the frontmatter cannot answer.
 *
 * `visibility` is a property of a note in every sense that matters to a
 * reader — it is what the breadcrumb's chip used to say, and it belongs in the
 * panel that lists what is filed about this note. What it must **not** come
 * from is the file: `ManifestNotice` says it plainly, and so does
 * `fileOps.ts` — a `visibility:` line inside a note changes nothing, because
 * `privacy.md` decides access. So a note that carries one has that row
 * *replaced* rather than shown alongside, and the panel never states two
 * different answers to "who can read this".
 *
 * Exported for its test: this is a claim about who can read somebody's note,
 * and "the row quietly stopped being added" is the kind of regression that is
 * invisible on screen until it matters.
 */
export function withVisibility(
  rows: Property[],
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  },
): Property[] {
  if (visibility === undefined) return rows;
  // The phone's wording, from `Breadcrumb`, so the two surfaces cannot come to
  // describe the same three cases differently — a note that merely follows a
  // `team` folder and a note deliberately shared as an exception have to stay
  // distinguishable wherever either is printed.
  const stated: Property = {
    key: "visibility",
    value: describeVisibility({ ...visibility, brief: true }),
  };
  const written = rows.findIndex((row) => row.key === "visibility");
  if (written === -1) return [stated, ...rows];
  return rows.map((row, index) => (index === written ? stated : row));
}

/**
 * `privacy.md` gets an explanation rather than a disabled cursor.
 *
 * Somebody who opens it is trying to find out how sharing works. Telling them
 * where the switch actually is answers that; greying the file out does not.
 */
function ManifestNotice() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice}>
      <Text variant="hint">
        This file is generated from your visibility settings and is read-only here. To
        change what a client can see, use the visibility control beside a file or folder
        in the tree — this file is rewritten to match. Editing{" "}
        <Text variant="hint" style={styles.noticeStrong}>
          visibility:
        </Text>{" "}
        in a note&apos;s own frontmatter changes nothing: frontmatter describes a note,
        this file decides access.
      </Text>
    </View>
  );
}

function statusLine(state: EditorState): string {
  switch (state.status) {
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "saved":
    case "error":
      return state.message ?? "";
    case "conflict":
      return "Conflict";
    default:
      return "Saved in your bucket";
  }
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: 12, flex: 1, minHeight: 0 },
  /** The document runs to the edges; what padding there is belongs to it. */
  wrapCompact: { gap: 0 },

  /** The phone's scroll surface: full height, padded in its content. */
  scroll: { flex: 1, minHeight: 0 },

  /**
   * Obsidian's inline title.
   *
   * 28 on a 34 line box, measured off the reference at 440pt: the name sits a
   * clear step above the note's own `# Heading` without becoming a masthead,
   * and it is the first ink on the page rather than a caption over it. The
   * negative tracking is what a bold face at this size needs to stop reading as
   * spaced-out; the side margin is `readingMargin`, the one number every band
   * that lines up with the first character of the note shares.
   *
   * `marginBottom` rather than a gap on the parent: the next thing down is
   * either the Properties card or the editor, and both bring their own top
   * space — one number here is easier to reason about than a gap that applies
   * between every pair.
   */
  inlineTitle: {
    paddingHorizontal: layout.readingMargin,
    // 20 above, measured: the reference leaves about 33pt between the bottom of
    // the floating toggle and the top of the title's line box, and
    // `contentInsets.top` already carries 12 of it.
    marginTop: space.x5,
    marginBottom: space.x1,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: colors.text,
  },

  /**
   * The Properties row and the editor under it, as one column.
   *
   * `flex: 1` with `minHeight: 0` so the editor keeps scrolling itself and the
   * row above it keeps its own height rather than being compressed out of
   * existence by a `flex: 1` sibling.
   */
  document: { flex: 1, minHeight: 0 },

  /**
   * A quiet line above the note, at the note's own left margin.
   *
   * `readingMargin` rather than a number of its own: this sits directly above
   * the first line of the document and anything else here would be visibly out
   * of step with it.
   */
  properties: {
    paddingHorizontal: layout.readingMargin,
    paddingTop: space.x1,
    paddingBottom: space.x2,
  },
  /**
   * The panel, as the reference draws it.
   *
   * A tinted rounded card rather than a bare list, which is the whole of what
   * makes it read as metadata *about* the note instead of as the note's first
   * paragraph. `radii.sheet` because this is a grouped card on a phone and that
   * is what the phone geometry in `tokens.ts` is for; `surface2` because the
   * ground is paper now and a card on paper separates by being a shade off it.
   *
   * The negative margin pulls it back out to the reference's own inset, which
   * is wider than the note's text column — Obsidian's card is not aligned to
   * its prose either, and a card indented to the text measure reads as part of
   * the text.
   */
  propertyCard: {
    marginTop: space.x1,
    marginHorizontal: -(layout.readingMargin - space.x4),
    paddingVertical: 6,
    borderRadius: radii.sheet,
    backgroundColor: colors.surface2,
  },
  propertiesHead: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: layout.minTouchTarget,
    paddingRight: space.x2,
    borderRadius: radii.sm,
  },
  propertiesHover: { backgroundColor: colors.surface3 },
  /**
   * One row: mark, key, value.
   *
   * A two-column grid is what this wants and what React Native does not have;
   * a fixed leading column is the honest approximation, and the keys in a
   * captured note (`sender-domain`, `authentication-result`) are long enough
   * that a shrink-to-fit column would be a different width on every note — so
   * the values would not line up down the card, which is the one thing a
   * two-column layout exists to do.
   *
   * `alignItems: "flex-start"` because a long value wraps: the mark and the key
   * stay on the first line rather than centring against a three-line value.
   */
  property: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.x2,
    minHeight: 36,
    paddingVertical: 5,
    paddingHorizontal: space.x4,
  },
  propertyMark: { width: 18, alignItems: "center", paddingTop: 4 },
  /**
   * 15 on a 22 line box, not the 12.5 a `treeMeta` row would be.
   *
   * These are values somebody reads — a captured note's subject, a sender, a
   * timestamp — and the reference sets them at reading size. Metadata type is
   * for the counts under a tree, where the number is a glance rather than a
   * sentence.
   */
  propertyKey: {
    width: 96,
    flexGrow: 0,
    flexShrink: 0,
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
  },
  propertyValue: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
  },
  /** Dimmed rather than absent — see the call site for why it is here at all. */
  propertyAdd: { opacity: 0.55 },
  propertyAddLabel: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
  },

  preview: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    // No `maxHeight`. It was 360 while this sat in a card on a scrolling page;
    // in a region that cap strands the reader two thirds of the way down a
    // screen with the rest of the note behind a scrollbar that need not exist.
  },
  previewContent: { paddingVertical: 14, paddingHorizontal: 16 },
  previewCompact: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  previewContentCompact: {
    paddingTop: space.x2,
    paddingHorizontal: layout.readingMargin,
    paddingBottom: space.x8,
  },
  codeKey: { color: colors.codeKey },
  codeHeading: { color: colors.text, fontWeight: "500" },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  /**
   * One quiet line under the note rather than a bar of controls.
   *
   * It carries the surface colour, which is not decoration: the editor above it
   * is `flex: 1` and clips, so without a fill the row sits directly against a
   * line of the document cut off mid-height, and the two read as one thing
   * overlapping. A painted strip reads as the foot of the region, which is what
   * it is.
   */
  statusRowCompact: {
    paddingHorizontal: layout.readingMargin,
    paddingTop: space.x2,
    paddingBottom: space.x2,
    backgroundColor: colors.surface,
  },
  status: { flexGrow: 1, flexShrink: 1 },

  conflict: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnWash,
    gap: 10,
  },
  conflictText: { color: colors.warnText },
  conflictActions: { flexDirection: "row", gap: 10 },

  notice: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  noticeStrong: { color: colors.hintStrong, fontFamily: fonts.mono },
});
