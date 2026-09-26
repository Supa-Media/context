import type { ReactNode } from "react";
import { View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { topBarLeadFor, type Density, type Regions } from "../frame";
import type { FrameApi } from "./context";
import { FrameIconButton, SearchTrigger } from "./controls";
import type { FrameStyles } from "./styles";

/**
 * The frame's top bar: the phone's account mark, the tabs, the
 * sync pill and the trailing group.
 *
 * A function that returns the element rather than a component, so the tree
 * `AppFrame` renders is exactly the one it rendered when this was inline — no
 * extra fibre, nothing for a render test to find twice.
 */
export function frameTopBar({
  styles,
  compact,
  insets,
  contentInsets,
  holdsLights,
  lightsLeadPx,
  density,
  accountSlot,
  lead,
  tabs,
  syncSlot,
  topTrailing,
  onSearch,
  asideToggle,
  regions,
  toggleAside,
}: {
  styles: FrameStyles;
  compact: boolean;
  insets: EdgeInsets;
  contentInsets: FrameApi["contentInsets"];
  holdsLights: boolean;
  lightsLeadPx: number;
  density: Density;
  accountSlot?: ReactNode;
  lead?: ReactNode;
  tabs?: ReactNode;
  syncSlot?: ReactNode;
  topTrailing?: ReactNode;
  onSearch?: () => void;
  asideToggle: boolean;
  regions: Regions;
  toggleAside: () => void;
}) {
  return (
    <View
      style={[
        styles.topBar,
        compact && styles.topBarCompact,
        compact && { paddingTop: insets.top, height: contentInsets.top },
        /*
          The bar holds the shell's traffic lights: it starts its own
          content clear of them and becomes the window's drag handle.

          `paddingLeft` rather than a spacer `View`, because the buttons
          are drawn by the OS over this bar and not by anything in this
          tree — there is no element to reserve, only room to leave. And
          the drag region is the bar rather than a strip inside it so that
          the top edge of the window is grabbable along its whole width,
          which is the property `docs/decisions/desktop.md` records the
          settings overlay keeping ("the window stays draggable by its top
          edge") and which this bar now owes on the console too.

          Every slot below sets `no-drag` on itself — see `topLead`. What
          stays draggable is the bar's own background: the gaps between
          slots, the run before the tabs, and the air above the tabs, which
          hang from the foot.
        */
        holdsLights && { paddingLeft: lightsLeadPx },
        holdsLights && styles.topBarDrag,
      ]}
      testID="app-top-bar"
    >
      {/*
        The phone's top row, in two parts: a pinned account mark and the
        trailing capsule. The contexts were the third and are now the first
        row of the navigation band inside the scroller — see `accountSlot`.

        **Two controls used to be here and both are gone with the panels.**
        A round drawer toggle at the leading edge pulled the file tree in —
        and crossed to the sliver of note when it did, so it did not lie on
        the panel it had opened — and the switcher chip pulled the rail in
        where no file tree was there to carry it at its foot. `frame.ts`
        answers `false` to both toggles at every density now, so what is
        left is not a bar with two buttons and a gap: it is a row of slots,
        and the middle one is a list.

        At medium and wide the console leads with nothing any more: the
        workspace switcher chip moved to the account button at the foot of
        the file tree (see `AppFrame`'s `account`), so its tabs start here.
        `lead` is for a surface that still names itself, like the homepage.
      */}
      {topBarLeadFor(density) === "account" ? (
        <>
          {accountSlot == null ? null : (
            /*
              Pinned, and alone at this edge. The contexts used to sit
              beside it and are now the first row of the navigation band
              inside the scroller — see the prop.
            */
            <View style={styles.accountLead}>{accountSlot}</View>
          )}
        </>
      ) : lead == null ? null : (
        <View style={styles.topLead}>{lead}</View>
      )}

      {/*
        THE OPEN NOTES, IN THE TITLE BAR, HANGING FROM ITS FOOT.

        **They were a band of their own between this bar and the note**,
        drawn by `EditorRegion` at the top edge of the editor region — with
        a `surface2` ground, a hairline under it, a right rule between every
        tab and an accent rule over the active one. Three horizontal bands
        stacked down a 900pt window, the middle one saying nothing the
        other two did not.

        Here they are what every browser and every editor with a real title
        bar draws: tabs hanging from the bottom edge of the chrome, with
        the active one filled in the *page's* own surface so it reads as
        the front edge of what is below it. That is why this slot is in
        the frame rather than in the region — the effect is the tab meeting
        the page across the boundary between two surfaces, and a strip
        drawn on the page has no boundary to meet.

        `alignSelf: "flex-end"` on the slot rather than a taller bar: the
        bar keeps `topBarHeight` and the tabs are shorter than it, which is
        what leaves the air above them.

        Compact draws none of this, and **the frame is where that is
        enforced** rather than only where it is described. Tabs are a
        pointer instrument (`TabStrip.tsx`: "there is no mobile half any
        more") and a phone has `RecentSheet` over `history.ts` instead.

        `_layout.tsx` also guards with `!phone`, and that guard is worth
        keeping — it avoids building a strip nothing will draw. But a prop
        whose contract lives only in its callers is a contract one caller
        can break silently, and one did: the visual fixture passed `tabs`
        unconditionally, so a 390pt board came back with a pointer tab
        strip across the top of the phone's note. Nothing failed; it was
        visible only in a screenshot.
      */}
      {tabs == null || compact ? null : <View style={styles.topTabs}>{tabs}</View>}

      {/*
        The trailing slot, which on a phone is **the** grouped container.

        Obsidian's top bar is exactly two objects: a rounded-square sidebar
        toggle at the leading edge, and one rounded container at the
        trailing edge holding the actions for what is on screen — the book
        and the ⋯ in the reference. Nothing in the middle. So at compact
        this is a floating capsule with the same surface and shadow the
        toggle has, and whatever `_layout` puts in it sits inside that one
        container rather than bringing a box of its own.

        It used to wrap its chips in a bordered, filled pill *and* let each
        chip draw its own border — three nested rounded boxes for two
        words. The chips themselves are gone from here: identity and the
        storage binding are facts about the context, and they live at the
        foot of the file tree where Obsidian puts the vault switcher.

        At every other density the bar has its own surface and its own
        hairline, the chips have room, and a container around them would be
        a box in a box — so `topTrail` alone, unfilled.
      */}
      {/*
        The trailing group, and search is part of it.

        Search sits in the top bar where there is a pointer and in the
        bottom toolbar where there is a thumb — rendering it in both would
        put the same control twice on the screen with least room. What
        changed is *where* in the bar: it was centred, on its own
        `marginLeft: "auto"`, which put two auto margins in one row and
        split the free space between them — so it sat in the middle of the
        band looking like a browser's omnibox rather than beside the other
        actions. One group, one push to the trailing edge, and the centre
        of the bar is free for what belongs there.
      */}
      {/*
        The phone's sync pill, leading the trailing side.

        It takes the row's one auto margin when it is drawn, and the capsule
        gives its up: two auto margins in one row split the free space
        between them, which would float this in the middle of the glass —
        the mistake the search comment below records once already.
      */}
      {compact && syncSlot != null ? <View style={styles.syncLead}>{syncSlot}</View> : null}
      {topTrailing == null && !(onSearch && !compact) && !asideToggle ? null : (
        <View
          style={[
            styles.topTrail,
            compact && styles.topTrailCompact,
            compact && syncSlot != null && styles.topTrailAfterSync,
          ]}
        >
          {onSearch && !compact ? <SearchTrigger onPress={onSearch} /> : null}
          {topTrailing}
          {/*
            The right panel's toggle, last in the trailing group and so at
            the trailing end of the bar — the mirror of the explorer's,
            which the status bar carries at the leading end.

            Drawn only where there is a panel to open: `asideToggleFor`
            answers `null` at compact and `aside` is absent on every
            surface that supplies none, and a control for a region that
            does not exist is the pair `frame.ts` spends a section keeping
            honest.

            The glyph says which state a press produces rather than which
            state is current, the way the note's read toggle does: a filled
            trailing pane means "this will open", and an outline means
            "this will close". One mark cannot carry both, and the label
            below says it in words for anyone who cannot see the mark at
            all.
          */}
          {asideToggle ? (
            <FrameIconButton
              label={regions.aside === "hidden" ? "Show chat and meetings" : "Hide chat and meetings"}
              icon={regions.aside === "hidden" ? "panelRight" : "panelLeft"}
              onPress={toggleAside}
              testID="frame-aside-toggle"
            />
          ) : null}
        </View>
      )}
    </View>
  );
}
