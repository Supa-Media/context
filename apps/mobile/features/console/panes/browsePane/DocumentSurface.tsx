import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { ScreenViewport, type useSurfacePadding } from "../../../app/Screen";
import { PageSlide } from "../../../design/components/PageSlide";
import { useThemedStyles } from "../../../design/theme";
import { slideDirection } from "../../home/phoneBack";
import type { classifyCommsPath } from "../../communications/paths";
import type { entryAt } from "../../files/tree";
import { makeStyles } from "./styles";

/**
 * Where the document goes: into its own scroller, into the phone's page
 * scroller with the path and the notices above it, or into the pointer
 * layout's page scroller. What the document is, is `BrowseDocument`'s.
 */
export function DocumentSurface({
  selected,
  compact,
  commsRoute,
  padding,
  openDocument,
  notices,
  pathBar,
  page = false,
}: {
  selected: ReturnType<typeof entryAt>;
  compact: boolean;
  commsRoute: ReturnType<typeof classifyCommsPath> | null;
  padding: ReturnType<typeof useSurfacePadding>;
  openDocument: ReactNode;
  notices: ReactNode;
  pathBar: ReactNode;
  /**
   * A page that is not the selection is on screen (What changed): it rides the
   * page scroller whatever is selected under it, since it brings none of its own.
   */
  page?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  /**
   * Whether whatever `openDocument` is about to draw brings its own scroller.
   *
   * ## Why the pane has to answer this
   *
   * A phone puts the whole region in one scroller and every document rides it.
   * A pointer layout cannot: `NoteEditor` owns a scroller *because* it does —
   * `NoteAccessory` is positioned against the bottom of the region and inside a
   * scroll container would ride away with the content — and a scroller nested
   * in a scroller is two scrollbars and a wheel event that goes to the wrong
   * one. So the pointer branch supplies a page scroller only where the document
   * does not have one, and that is a question only this file can answer,
   * because this file is where the branch that picks the document lives.
   *
   * ## What it was before
   *
   * `<View style={styles.body}>{openDocument}</View>`, for everything. A note
   * was fine and so was a conflict; **a folder listing, the Inbox, a channel
   * and a contact page had no scroller at all** — and neither did anything
   * above them, so there was nothing on the screen that could scroll. Measured
   * in Chromium at 1440×900 on a fifty-row `4-archive`: the last row laid out
   * at y≈1850, and walking up from it to the document found no ancestor with a
   * scrolling overflow. The rows past the fold were drawn and simply
   * unreachable — no scrollbar, no wheel, no keyboard, and no hint that the
   * listing went on. Reported 2026-09-18 against exactly that folder.
   *
   * ## Why it is one expression and not a flag per branch
   *
   * It is derived from the same two values the chain below switches on, in the
   * same order, so the two cannot drift into disagreeing about which surface is
   * on screen. Read it against `openDocument`:
   *
   *  - no selection — the empty state, or the phone's landing listing: neither
   *    scrolls itself;
   *  - a comms route — `ChannelDayView` owns a scroller (it scrolls to the
   *    anchored message on open, which is the whole reason it has one); the
   *    Inbox, a channel and a contact page do not;
   *  - otherwise a file — `ConflictResolver` and `NoteEditor` both own one, and
   *    they are the only two things a `file` selection can draw.
   */
  const documentOwnsScroller =
    !page &&
    selected !== null &&
    (commsRoute === null ? selected.kind === "file" : commsRoute.kind === "channel-day");

  return (
    <>
      {/*
        The document, and the one full-bleed scroll surface it lives on.

        On a phone nothing here is a band the note is kept out of. The region
        runs from the top of the glass to the bottom, the toolbar and the top
        bar lie over it, and the scroller pays for both in **content padding**
        with matching `scrollIndicatorInsets` — so the first line and the last
        can each be brought out from under the chrome and everything between
        passes behind it. Padding the content rather than shrinking the viewport
        is the whole difference: a scroller that stops where the toolbar begins
        has a hard edge across the glass and can never scroll its last line
        clear of anything.

        A note brings its own scroller rather than sitting in this one, and that
        is not a preference. `NoteAccessory` rides above the keyboard by being
        absolutely positioned at the bottom of the *region*; inside a scroll
        container it would anchor to the bottom of the content instead and ride
        away with it. So `NoteEditor` owns a scroller with the accessory bar as
        its sibling, and takes the notices as a prop so they scroll with the
        document rather than pinning a band above it.
      */}
      {compact ? (
        /*
          One slide for every page a phone shows, so going from a folder into
          a note — two different branches below — is still one navigation the
          slide can see (`PageSlide`).
        */
        <PageSlide pageKey={selected?.path ?? ""} directionOf={slideDirection} testID="page-slide">
          {!page && selected !== null && selected.kind === "file" ? (
            openDocument
          ) : (
            /*
              The status bar's band goes on the box *around* the scroller and our
              own chrome inside it — see `SurfacePadding` in `app/frame.ts`. Spent
              together on the content, the whole inset scrolled away with the
              listing and the folder's rows rode up under the clock.
            */
            <ScreenViewport padding={padding}>
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={{
                  paddingTop: padding.content.top,
                  paddingBottom: padding.content.bottom,
                }}
                scrollIndicatorInsets={{
                  top: padding.content.top,
                  bottom: padding.content.bottom,
                }}
                testID="browse-scroll"
              >
                {/*
                  `pathBar` was the folder path, and is now only who else is in
                  the note: the way up is the ‹ back button at the top left (see
                  `BrowsePathBar`, owner's review 2026-10-01).
                */}
                {pathBar}
                {notices}
                <View style={styles.bodyCompact}>{openDocument}</View>
              </ScrollView>
            </ScreenViewport>
          )}
        </PageSlide>
      ) : documentOwnsScroller ? (
        <>
          {notices}
          <View style={styles.body}>{openDocument}</View>
        </>
      ) : (
        /*
          The pointer layout's page scroller, for the documents that do not
          bring one — see `documentOwnsScroller` for which and why.

          The padding is the content container's rather than the box's, for the
          same reason the phone's scroller pays its chrome in content padding: a
          scroller inset by its parent has a hard edge and a track that floats
          away from the pane. `flexGrow: 1` on the content keeps a short page
          filling the region, which is what `FolderView`'s own `flexGrow`
          needs — its right-click background is the whole area, not a strip
          under the last row, and a content container that hugged its children
          would shrink that target to the height of the listing.
        */
        <>
          {notices}
          <ScrollView
            style={styles.page}
            contentContainerStyle={styles.pageContent}
            testID="document-scroll"
          >
            {openDocument}
          </ScrollView>
        </>
      )}
    </>
  );
}
