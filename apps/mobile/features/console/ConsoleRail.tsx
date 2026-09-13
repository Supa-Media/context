import { useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { ContextRowMenu, RightClickTarget } from "./ContextRowMenu";
import { PressRow } from "../design/components/Button";
import { Dot } from "../design/components/Dot";
import { Icon, type IconName } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { Text } from "../design/components/Text";
import { gradient } from "../design/css";
import { layout, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { offerOwnContext } from "../onboarding/route";
import { atName } from "./format";
import type { MenuItem } from "./files/menu";
import { selectContextRoute, type ConsoleRoute } from "./nav";
import { isOwnWorkspace, railGroup } from "./rail";
import type { ConsoleData } from "./types";

/**
 * The rail: where you are, everywhere you can go, and who you are signed in as.
 *
 * Split out of `ConsoleShell` when the console moved into a real application
 * frame. The shell still exists and still draws its own rail, because the
 * landing page mounts it as a *picture* of the product inside a fake window;
 * this one is the rail of the running application, and it carries two things
 * the picture never needed.
 *
 * ## The account block, pinned to the bottom
 *
 * Sign-out used to live in a marketing header above the console, beside the
 * wordmark — which is where a *website* puts it. Every application puts the
 * signed-in identity at the foot of its navigation, because that is where
 * people look for it, and because a header that exists only to hold one button
 * is a header you can delete. It is pinned rather than scrolled: a list of
 * contexts long enough to scroll must not be able to push your own identity
 * off the screen.
 *
 * ## Three modes, one rail
 *
 * `icons` is not a different component. A medium window pays for the explorer
 * column with the rail's labels, and a wide window can be collapsed to the same
 * state deliberately, so both arrive here as a mode. Every entry keeps its
 * accessibility label at every mode — a rail that becomes a row of unlabelled
 * glyphs to a screen reader is not collapsed, it is broken.
 *
 * `sheet` is the phone: the same labels as `full`, on targets a thumb can
 * actually hit. It is a mode rather than `full` with a flag because the sizes
 * genuinely fork — `features/app/frame.ts` argues that a 44pt row is wrong
 * under a pointer and a 24px row is unusable under a thumb, and a rail that
 * takes one number to both surfaces has picked a side. Sign-out is the case
 * that proves it: the reason the sheet exists at all is that it is the only
 * way off a pane on a phone, and a 28×28 power button at the bottom of it
 * would be a way out you cannot reliably press.
 */
export function ConsoleRail({
  data,
  route,
  mode,
  onNavigate,
  account,
  onClaimContext,
  onCreateWorkspace,
  onLeaveContext,
  onOpenMeetings,
}: {
  data: ConsoleData;
  route: ConsoleRoute;
  mode: "full" | "icons" | "sheet";
  onNavigate: (route: ConsoleRoute) => void;
  /** The account block. Passed in so the rail never imports auth. */
  account: ReactNode;
  /**
   * Open meeting capture.
   *
   * A callback rather than a `ConsoleRoute` for `onClaimContext`'s reason:
   * `/meetings` is outside `/console`, so putting it in that union would mean
   * `routeForPath` pretending it can parse a URL it never sees. Absent on the
   * landing page's picture of the rail, which has nowhere to send anybody.
   *
   * **It navigates and it does not record.** `docs/decisions/meetings.md` says
   * the product may never make recording invisible, and a row in a rail that
   * opened the microphone would be exactly the thing that section refuses. The
   * record button lives on `/meetings`, beside the sentence saying where the
   * audio goes.
   */
  onOpenMeetings?: () => void;
  /**
   * Start the flow that gives this person a context of their own.
   *
   * Absent on the landing page's copy of the rail, which is a picture and has
   * nowhere to send anybody, and absent for anyone who already owns one — the
   * decision is `offerOwnContext`, not this prop. Passed in rather than routed
   * here because `/welcome` is outside the console, so it is not a
   * `ConsoleRoute` and putting it in that union would mean `routeForPath`
   * pretending it could parse a URL it never sees.
   */
  onClaimContext?: () => void;
  /**
   * Start the flow that makes a new shared workspace.
   *
   * Absent on the landing page's copy of the rail, which is a picture, and in
   * the read-only demo — the same rule as `onClaimContext`, and the same
   * reason it is a prop rather than a `ConsoleRoute`: `/workspace/new` is
   * outside the console, so putting it in that union would mean `routeForPath`
   * pretending it could parse a URL it never sees.
   *
   * Unlike the claim entry there is **no client-side condition** on offering
   * it. How many workspaces one account may own is the control plane's rule
   * (`MAX_WORKSPACES_PER_USER`), enforced in `createWorkspace`'s transaction,
   * and a second copy here would be the copy that is wrong after a deploy —
   * hiding the entry from somebody who is under the limit, or showing a screen
   * that refuses. The refusal is rendered where the person can act on it.
   */
  onCreateWorkspace?: () => void;
  /**
   * Leave a context somebody shared. Receives the workspace id. Absent on
   * the landing page's picture of the rail, where there is nothing to leave.
   */
  onLeaveContext?: (contextId: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const icons = mode === "icons";
  const touch = mode === "sheet";
  // Which context's right-click menu is open, if any. One at a time: opening
  // a second closes the first, which is what every menu bar does.
  const [menuSlug, setMenuSlug] = useState<string | null>(null);
  const menuOpenOn = (slug: string) => slug === menuSlug;
  const claimable = onClaimContext !== undefined && offerOwnContext({
    contexts: data.contexts,
    loading: data.loading,
  });
  // One list, computed once: the contexts with this person's own workspace
  // pinned first, and whether each of the two offers is being made. See
  // `rail.ts` for why there is no longer a group per kind.
  const group = railGroup({
    contexts: data.contexts,
    claimable,
    creatable: onCreateWorkspace !== undefined,
  });

  return (
    // The rail's own root, named so a test can assert the *order* of its three
    // children rather than an entry's relationship to its own parent — which
    // travels with the entry and proves nothing. See `meetingsEntry.test.ts`.
    <View style={styles.rail} testID="console-rail">
      {/*
        The app's other place, pinned above the contexts.

        ## Why it is in the rail at all

        Meeting capture shipped with a list screen, a live screen and a working
        recorder, and **nothing in the app navigated to any of it**. This is a
        way in on the densities that have a rail.

        The settings pane was refused by its own file and still is: its "This
        context, from further out" card is explicitly for things that are *not*
        "a place you navigate to in order to read a note", which a meeting
        screen is.

        **The bottom toolbar's refusal has expired, and it expired on
        arithmetic.** This used to read: "the bottom toolbar's rule is that
        'navigation is not its job', and it has no room either — at 390pt its
        pill is 286 wide, 262 inside its padding, which six targets already
        divide into 43.7pt against a 44pt floor. A seventh does not fit." Both
        halves have moved. `layout.bottomBarInset` went **52 → 24** when the
        phone lost its left panel, which is what bought the seventh key: the
        286 in that sentence was `390 − 2 × 52`, and it is `390 − 2 × 24 = 342`
        now, 318 inside `bottomBarPad` and **317 once the separator has taken
        its point** — it is a `flexShrink: 0` child of the same flex row, so
        that point comes off what the targets divide rather than being painted
        over them — so seven targets are **45.29pt** rather than 37.29 and clear
        the 44pt floor. `BottomBar`'s own rule was amended in the same change —
        it carries exactly one destination, last, behind a separator — and
        `layout.bottomBarInset` carries the arithmetic so no file has to quote
        it twice.

        So a phone reaches meetings through that seventh key, and this row is
        the answer for medium and wide, where there is no bottom bar at all
        (`features/app/frame.ts`: the bottom bar and the status bar are never
        both present). The two are not a duplicate; they are one destination on
        the surface each density actually has.

        This is not the `App` group coming back. That group held Map and
        Connections — facts *about a context*, which is why they moved into that
        context's settings — and it was headed APP over YOURS over SHARED WITH
        YOU, which is what made the rail read as a second, unrelated left
        navigation. One pinned row with no heading is not a second panel.

        ## Why pinned, and why at the head

        Pinned for the account block's reason, mirrored: a context list long
        enough to scroll must not be able to push the app's other place off the
        screen either.

        At the head rather than beside sign-out because of what floats at the
        other edge. The persistent recording bar is anchored to the bottom of
        the glass, and where the frame publishes a chrome height of zero
        (`features/app/bottomChrome.ts`) the bar drops to
        `floatingStackBottom(insets.bottom, 0)` and lies across the bottom
        ~100pt of whatever is under it. A destination that the recording it
        leads to can cover is not a destination.
      */}
      {onOpenMeetings === undefined ? null : (
        <View style={[styles.head, icons && styles.headIcons]} testID="rail-head">
          <RailEntry
            label="Meetings"
            icon="mic"
            icons={icons}
            touch={touch}
            accessibilityLabel="Open meetings"
            selected={false}
            onPress={onOpenMeetings}
            testID="rail-meetings"
          />
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, icons && styles.contentIcons]}
        showsVerticalScrollIndicator={false}
      >
        {/*
          **There is no "App" group here any more, and that is the point.**

          It held Map and Connections, and having them in the rail is what made
          this panel a second, unrelated left navigation: on a phone the same
          edge and the same gesture produced either the file tree or a list
          headed APP / YOURS / SHARED WITH YOU, and which one you got depended
          on which control you had pressed. Obsidian has one sidebar whose
          *contents* switch; it never becomes a different panel.

          So this is the vault switcher and nothing else — the workspaces you
          can open, and who you are signed in as. Map and
          Connections are facts about a context rather than places inside one,
          and they live in that context's settings, behind the gear at the foot
          of the tree. Their routes are unchanged and still addressable; what
          moved is where you reach them from. See `SettingsPane`.
        */}
        {/*
          **One list, not a group per kind.** Every context a person can reach
          is a workspace, so a heading for each kind was a division with
          nothing to divide. What the split carried is carried by the pin and
          the mark instead: this person's own workspace leads the list and says
          "yours", and `@sayo` already says whose the others are. See
          `rail.ts`.
        */}
        <Group
          heading={group.heading}
          icons={icons}
          // Derived from the one piece of state that already knows, rather
          // than a second answer to the same question.
          raised={group.contexts.some((context) => menuOpenOn(context.slug))}
        >
          {/*
            "Nothing here yet" and the claim entry are alternatives, never
            neighbours. Both are for an account with nothing in the list, and
            the two-group rail could draw them together — an empty state above
            a live offer, which reads as a screen that failed to load *and* a
            screen that works. One group has to choose, and it chooses the
            offer.
          */}
          {data.contexts.length === 0 && !data.loading && !group.claim ? (
            icons ? null : (
              <Text variant="rowSub" style={styles.empty}>
                Nothing here yet
              </Text>
            )
          ) : null}
          {/*
            The way to have a workspace of your own, for somebody who does not.

            **It takes the pinned top slot** — the one a person's own workspace
            sits in for everybody else — because that is precisely what it is a
            placeholder for, and `railGroup` refuses to offer it beside the row
            it stands in for. Below the list, or in a group of its own, it
            would read as a verb about the application rather than as the gap
            at the top of this one.

            It is drawn accented rather than as another quiet row on purpose.
            The person this is for arrived through somebody else's invitation
            and has no reason to suspect the product does anything else; a row
            that matched its neighbours would be discoverable only by reading
            every word in the rail. This is the one entry that has to be
            noticed, and it stops existing the moment it is used.
          */}
          {group.claim ? (
            <RailEntry
              label="Claim your @name"
              icon="plus"
              icons={icons}
              touch={touch}
              accessibilityLabel="Claim your name and create your own workspace"
              onPress={onClaimContext!}
              style={styles.claim}
              labelStyle={styles.claimLabel}
              testID="rail-claim-context"
            />
          ) : null}
          {group.contexts.map((context) => (
            // Right-clicking a context offers its verbs — Settings, sharing
            // — because the rail entry is the visible handle for the
            // context, and the storage pill in the corner was findable only
            // by people who already knew it was there.
            <RightClickTarget
              key={context.id}
              open={menuOpenOn(context.slug)}
              onOpenMenu={() => setMenuSlug(context.slug)}
            >
              <RailEntry
                label={atName(context.slug)}
                // A context has no icon of its own, so the initial stands in —
                // the same letter the avatar uses, which is what makes a
                // collapsed rail learnable rather than a row of identical
                // marks. It is a *letter*, which is why `RailEntry` takes an
                // initial and an icon separately rather than one "mark":
                // there is no icon that means "@seyi" and drawing a generic
                // one for every context is the row of identical dots this
                // avoids.
                initial={context.slug.slice(0, 1).toUpperCase()}
                icons={icons}
                touch={touch}
                accessibilityLabel={`Open ${atName(context.slug)}`}
                selected={route.kind === "context" && route.slug === context.slug}
                onPress={() => onNavigate(selectContextRoute(context.slug))}
                leading={<Dot tone={context.status} />}
                /*
                  Where ownership went when it stopped being a section.

                  Only ever on one row — `isOwnWorkspace` requires a
                  personal context you own, and there is one of those per
                  person. It is
                  a quiet label rather than a badge: the row it marks is the
                  one the person recognises fastest anyway, so this only has
                  to settle the question, not raise it.

                  Dropped in the collapsed rail with the rest of the trailing
                  slot. Nothing is lost — the account block at the foot names
                  the signed-in person, so the initial that matches it is the
                  same answer in less space.
                */
                trailing={
                  isOwnWorkspace(context) ? (
                    <Text variant="foot" style={styles.yours}>
                      yours
                    </Text>
                  ) : null
                }
              />
              {menuOpenOn(context.slug) ? (
                <ContextRowMenu
                  slug={context.slug}
                  // The role, not the row's place in the list. Some of
                  // these workspaces are yours and some are not, and leaving
                  // is only ever for the ones that are not — see
                  // `contextMenuItems`.
                  canLeave={context.role !== "owner"}
                  onSelect={(target) => {
                    setMenuSlug(null);
                    onNavigate(target);
                  }}
                  onLeave={
                    onLeaveContext
                      ? () => {
                          setMenuSlug(null);
                          onLeaveContext(context.id);
                        }
                      : undefined
                  }
                  onDismiss={() => setMenuSlug(null)}
                />
              ) : null}
            </RightClickTarget>
          ))}
          {/*
            The foot of the list, under the workspaces it makes more of.

            Quiet rather than accented, unlike the claim entry: that one is
            drawn loudly because it is for somebody who has no reason to
            suspect the product does anything else, and it disappears the
            moment it is used. This one is permanent, so an accent on it would
            be an advertisement on every screen of every session. It reads as
            what it is — a verb at the foot of the list it adds to.

            It is also the only *offer* for somebody who is in no shared
            workspace yet, which is how a person who has only ever had their
            own finds out that shared ones exist.
          */}
          {group.create ? (
            <RailEntry
              label="New workspace"
              icon="plus"
              icons={icons}
              touch={touch}
              accessibilityLabel="Create a new shared workspace"
              onPress={onCreateWorkspace!}
              testID="rail-create-workspace"
            />
          ) : null}
        </Group>
      </ScrollView>

      <View style={[styles.account, icons && styles.accountIcons]}>{account}</View>
    </View>
  );
}

/**
 * One labelled block of the rail.
 *
 * `raised` is the group's half of the fix for issue #197. A group is an
 * ordinary react-native-web `View`, which means `position: relative;
 * z-index: 0` and therefore a stacking context of its own — so an open context
 * menu, however high its own `zIndex`, is ordered against the other groups by
 * *this* element's `0`, and the group that follows paints over it and takes the
 * click. The group holding the open menu is lifted while it is open; every
 * other group stays where it is, because lifting them all would leave the rail
 * in exactly the same order it is in now.
 */
function Group({
  heading,
  icons,
  raised,
  children,
}: {
  heading: string;
  icons: boolean;
  /**
   * True while a context menu is open on one of this group's rows. Required,
   * like `RightClickTarget`'s `open`, so that forgetting it is a compile error
   * rather than a menu that silently paints under the group below.
   */
  raised: boolean;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.group, raised && styles.groupRaised]}>
      {icons ? (
        // A hairline instead of a word. The grouping is still visible, which is
        // what the heading was for; the label would not fit and truncating it
        // to "Ap…" says less than a rule does.
        <View style={styles.groupRule} aria-hidden />
      ) : (
        <Text variant="railHead" style={styles.heading}>
          {heading}
        </Text>
      )}
      {children}
    </View>
  );
}

function RailEntry({
  label,
  icon,
  initial,
  icons,
  touch = false,
  selected,
  onPress,
  leading,
  trailing,
  role = "button",
  accessibilityLabel,
  style,
  labelStyle,
  testID,
}: {
  label: string;
  /** The mark for this destination, where one exists. */
  icon?: IconName;
  /** A letter standing in for a destination that has no icon — see the call site. */
  initial?: string;
  icons: boolean;
  /** Phone sizing: the row clears `layout.minTouchTarget` on both axes. */
  touch?: boolean;
  selected?: boolean;
  onPress: () => void;
  leading?: ReactNode;
  /**
   * Rendered after the label, in the expanded rail only.
   *
   * Dropped in the collapsed rail rather than shrunk: a 28px column has room
   * for one mark, and that one is the initial. Whatever this carries has to be
   * a *supplement* to something the row already says — the "yours" mark next to
   * a handle the person recognises — never the only place a fact appears.
   */
  trailing?: ReactNode;
  role?: "button" | "tab";
  accessibilityLabel?: string;
  /** Painted over the sizing style, so a mode never loses its target size. */
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      // The label survives the collapse. A rail that reads as a row of
      // unlabelled glyphs to a screen reader is broken, not compact.
      accessibilityLabel={accessibilityLabel ?? label}
      role={role}
      selected={selected}
      onPress={onPress}
      radius={radii.md}
      style={[icons ? styles.entryIcons : touch ? styles.entryTouch : styles.entry, style]}
      hoverStyle={styles.entryHover}
      selectedStyle={styles.entryOn}
      testID={testID}
    >
      {icons ? (
        initial === undefined ? (
          <Icon
            name={icon ?? "chevronRight"}
            size={17}
            color={selected ? colors.accentText : colors.text2}
          />
        ) : (
          <Text style={[styles.glyph, selected && styles.glyphOn, labelStyle]} aria-hidden>
            {initial}
          </Text>
        )
      ) : (
        <>
          {/*
            A destination's own mark, where it has one. Drawn in the sheet as
            well as in the collapsed rail: a phone list of six rows with two
            different kinds of leading element — a status dot for a context, an
            icon for a pane — is what makes the two groups legible at a glance,
            and Obsidian's own sheets carry one per row for the same reason.
          */}
          {leading ?? (icon === undefined ? null : (
            <Icon
              name={icon}
              size={touch ? 18 : 15}
              color={selected ? colors.accentText : colors.muted}
            />
          ))}
          <Text
            variant={touch ? "railTouch" : "rail"}
            style={[selected ? styles.entryOnLabel : undefined, labelStyle]}
            numberOfLines={1}
          >
            {label}
          </Text>
          {trailing}
        </>
      )}
    </PressRow>
  );
}

/**
 * Who you are signed in as, and the way out.
 *
 * Takes plain values and one callback so the rail imports no auth and no
 * router — which is what lets the whole rail be mounted in a test, and what
 * keeps the landing page's copy of it honest.
 *
 * ## `compact` is the phone's whole sign-out now, so it is a real target
 *
 * The two forms used to differ in weight: the full block is the rail's foot and
 * the compact one was a mark in a corner, drawn where there was no room for a
 * name. A phone has no rail at all now (`features/app/frame.ts`), so this
 * compact form — pinned in `AppFrame`'s `accountSlot` — is **the only sign-out
 * control on that density**, and it is what `signOutTouch` says of the other
 * one: the one control somebody reaches for deliberately and must not miss.
 *
 * So the pressable is `layout.minTouchTarget` on both axes while the mark
 * inside it stays 26. That is `accountAvatar`'s own rule — "what a thumb hits
 * is the pressable around it, and the caller pads to the floor" — actually
 * applied; it used to pad by 4, which is 34, which is under the floor.
 *
 * ## The corner used to be two controls, and one of them signed you out on one press
 *
 * The paragraph above is still true of the *target*; it stopped being true of
 * what the corner drew. It was two 44×44 pressables 4pt apart — a gear that
 * opened Settings, and the avatar itself, whose `onPress` was `onSignOut`
 * directly. "The setting button should be merged with the person icon, right
 * now all it does is sign you out" — and on a clean queue, `useSignOutFlow`'s
 * `requestSignOut` raises no confirmation at all (`if (warning === null) {
 * signOutNow(); return; }`), so that corner tap ended the session with no
 * question asked. Two deliberate presses (open the menu, then choose) *is*
 * the missing confirmation for that case, not a decoration added beside it.
 *
 * `compact` is one pressable now, holding the avatar, opening a `Menu` with
 * both actions in it — the same disclosure menu `Explorer.tsx`'s right-click
 * and long-press already draw from, reused rather than reinvented, per
 * `docs/decisions/app-and-console.md`. **The harm the two-control layout
 * caused was a control that ambiguously did one thing or the other depending
 * on which 44×44 square a thumb landed in**; a menu with two rows that say
 * the words is strictly more explicit than a coloured disc whose only
 * disambiguation was an `aria-label` nobody speaking to a screen reads twice
 * a session. Fixing "one control, two meanings" by drawing it as one control
 * with a disclosure step is the same shape `Menu.tsx`'s own header argues for
 * a destructive row: say what it is before it happens, not after.
 */
export function AccountBlock({
  name,
  detail,
  initial,
  onSignOut,
  onOpenSettings,
  compact = false,
  touch = false,
}: {
  name: string;
  detail?: string;
  initial: string;
  onSignOut: () => void;
  /**
   * Settings, from the one place that is on screen at every density.
   *
   * It was reachable only from the storage chip — which is pointer-only and
   * reads as a status, not a control — and from a long press on a context row,
   * which nobody discovers. A person looking for settings looks near their own
   * name, so it is here, beside the sign-out it has always sat next to.
   */
  onOpenSettings?: () => void;
  compact?: boolean;
  /** Phone sizing: sign-out clears `layout.minTouchTarget` on both axes. */
  touch?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (compact) {
    return (
      <View style={styles.accountPinned}>
        <AccountMenuTrigger
          name={name}
          detail={detail}
          initial={initial}
          onSignOut={onSignOut}
          onOpenSettings={onOpenSettings}
        />
      </View>
    );
  }

  return (
    <View style={styles.accountRow}>
      <Avatar initial={initial} />
      <View style={styles.accountText}>
        <Text variant="rowTitle" numberOfLines={1}>
          {name}
        </Text>
        {detail ? (
          <Text variant="treeMeta" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {onOpenSettings === undefined ? null : (
        <PressRow
          accessibilityLabel="Settings"
          onPress={onOpenSettings}
          radius={radii.md}
          style={touch ? styles.signOutTouch : styles.signOut}
          hoverStyle={styles.signOutHover}
          testID="rail-settings"
        >
          <Icon name="gear" size={15} />
        </PressRow>
      )}
      <PressRow
        accessibilityLabel="Sign out"
        onPress={onSignOut}
        radius={radii.md}
        style={touch ? styles.signOutTouch : styles.signOut}
        hoverStyle={styles.signOutHover}
        testID="rail-sign-out"
      >
        <Text style={styles.signOutGlyph} aria-hidden>
          ⏻
        </Text>
      </PressRow>
    </View>
  );
}

export function Avatar({ initial }: { initial: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.avatar, gradient("linear-gradient(140deg,#3B82F6,#8B5CF6)")]}
      aria-hidden
    >
      <Text style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

/** The two things `compact`'s single control can do. */
type AccountMenuActionId = "settings" | "signOut";

/**
 * The compact corner, merged into one disclosure control.
 *
 * See `AccountBlock`'s own doc comment for why this replaced two adjacent
 * pressables — this is the "how". `Menu`/`Menu.web` are generic in their own
 * id union (`features/console/files/menu.ts`'s `MenuItem<Id>`) for exactly
 * this: the sheet and the popover both already exist, both already pick the
 * right one for the width, and reusing them is the point rather than a third
 * menu idiom (`ContextRowMenu` is the file tree's own bespoke one, and this is
 * not a file's menu).
 */
function AccountMenuTrigger({
  name,
  detail,
  initial,
  onSignOut,
  onOpenSettings,
}: {
  name: string;
  detail?: string;
  initial: string;
  onSignOut: () => void;
  onOpenSettings?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  /**
   * Where the popover appears, on a pointer.
   *
   * Touch ignores this entirely (`Menu.web.tsx` picks the sheet under
   * `layout.narrowBreakpoint`, and `Menu.tsx`'s native sheet never reads
   * `anchor` at all) — it matters only for the collapsed pointer rail's
   * `compact` (`mode === "icons"` in `console/_layout.tsx`), where this
   * button sits wherever the rail is, not in a fixed corner. Measured at
   * press time rather than carried from layout, the same way `Explorer.tsx`
   * and `TabStrip.tsx` capture a row's position for their own context menus:
   * a value computed once at render and reused across presses would still be
   * right the first time and stale after the rail scrolls.
   */
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);

  const items: MenuItem<AccountMenuActionId>[] = [];
  if (onOpenSettings !== undefined) {
    items.push({ id: "settings", label: "Settings…", testID: "account-settings" });
  }
  items.push({ id: "signOut", label: "Sign out", danger: true, testID: "account-sign-out" });

  return (
    <>
      <View
        ref={triggerRef}
        // Measurement only: an unstyled `View` sizes to its one child, so
        // this adds no second box around the 44×44 pressable below.
      >
        <PressRow
          accessibilityLabel={`${name} — account menu`}
          onPress={() => {
            triggerRef.current?.measureInWindow((x, y, _width, height) => {
              setAnchor({ x, y: y + height });
            });
            setOpen(true);
          }}
          radius={radii.pill}
          style={styles.avatarOnly}
          hoverStyle={styles.entryHover}
          testID="account-menu"
          ariaHasPopup="menu"
          ariaExpanded={open}
        >
          <Avatar initial={initial} />
        </PressRow>
      </View>
      {open ? (
        <Menu<AccountMenuActionId>
          items={items}
          title={name}
          titleDetail={detail}
          anchor={anchor}
          onSelect={(id) => {
            if (id === "settings") onOpenSettings?.();
            else onSignOut();
          }}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  rail: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { paddingVertical: space.x4, paddingHorizontal: space.x3 },
  contentIcons: { paddingHorizontal: space.x2, alignItems: "center" },

  group: { marginBottom: space.x5, gap: 2, alignSelf: "stretch" },
  /** Above the groups that follow it, while one of its rows has a menu open. */
  groupRaised: { zIndex: 1 },
  heading: { marginBottom: space.x2, paddingHorizontal: space.x2 },
  groupRule: {
    height: 1,
    marginVertical: space.x2,
    marginHorizontal: space.x2,
    backgroundColor: colors.line,
  },
  empty: { paddingHorizontal: 9, paddingVertical: 7 },

  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    width: "100%",
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: radii.md,
  },
  entryIcons: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
  /**
   * The same row, thumb-sized. 7pt of padding around a ~21pt line gives 35 on a
   * pointer, which is right there and wrong under a thumb. Spelled out rather
   * than composed with `entry` because `PressRow` takes one style, and the
   * neighbouring `entryIcons` already sets the precedent.
   */
  entryTouch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    width: "100%",
    minHeight: layout.minTouchTarget,
    paddingVertical: space.x3,
    paddingHorizontal: 9,
    borderRadius: radii.md,
  },
  entryHover: { backgroundColor: colors.surface2 },
  /**
   * The one rail entry that is allowed to ask for attention.
   *
   * A tinted wash and an accent hairline — the same pair the hint notices use
   * — rather than a filled button. `entryOn` is the *selected* treatment and
   * borrowing it would say "you are here" about a route nobody is on.
   */
  claim: {
    marginTop: space.x2,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  claimLabel: { color: colors.hintStrong },
  /**
   * The "yours" mark.
   *
   * `marginLeft: auto` rather than a fixed gap, so it sits against the right
   * edge and does not move when the handle beside it is one character or
   * twenty; `flexShrink: 0` so a long handle truncates (the label is
   * `numberOfLines={1}`) instead of squeezing this out of the row.
   */
  yours: { marginLeft: "auto", flexShrink: 0, color: colors.muted },
  entryOn: { backgroundColor: colors.accentDim },
  entryOnLabel: { color: colors.accentText },
  glyph: { color: colors.text2, fontSize: 14 },
  glyphOn: { color: colors.accentText },

  /**
   * The head, which is the account block's mirror at the other end.
   *
   * A hairline under it rather than a heading over it: the row names itself,
   * and a one-row group with a `railHead` label above it is two lines of chrome
   * for one destination — the `App` group's mistake in miniature. The padding
   * matches `content` so the row lands on the same left edge as every context
   * below it.
   */
  head: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: space.x2,
    paddingHorizontal: space.x3,
  },
  headIcons: { paddingHorizontal: space.x2, alignItems: "center" },

  /** Pinned: a long context list must not push your identity off the screen. */
  account: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingVertical: space.x2,
    paddingHorizontal: space.x3,
  },
  accountIcons: { paddingHorizontal: space.x2, alignItems: "center" },
  accountRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
  accountText: { flex: 1, minWidth: 0 },
  /**
   * The pinned account mark, and the only sign-out a phone has.
   *
   * `padding: 4` around a 26pt mark is 34, which is `accountAvatar` and is
   * **under `minTouchTarget`** — legal for a mark and not for the pressable
   * around it, which is the distinction that token draws and this style was on
   * the wrong side of. Square on both axes so the pill radius reads as a
   * circle rather than as a stadium.
   */
  accountPinned: { flexDirection: "row", alignItems: "center", gap: space.x1 },
  avatarOnly: {
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
  },

  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#5F6EF6",
  },
  avatarInitial: { fontSize: 11, fontWeight: "700", color: "#fff" },

  signOut: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
  /**
   * The way out, on the surface where it is the only way out. 28×28 is a
   * pointer's target; this is the one control in the sheet somebody reaches for
   * deliberately and must not miss.
   */
  signOutTouch: {
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
  signOutHover: { backgroundColor: colors.surface3 },
  signOutGlyph: { fontSize: 13, color: colors.muted },
});
