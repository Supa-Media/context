import { useRef, useState } from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";

import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { layout, radii, space } from "../design/tokens";
import { openFeedback } from "../feedback/request";
import { canSendFeedback } from "../observability/client";
import { offerOwnContext } from "../onboarding/route";
import { Avatar } from "./AccountBlock";
import {
  AccountCard,
  type AccountCardAnchor,
  type AccountCardRow,
  type AccountCardSection,
} from "./AccountCard";
import type { MenuItem } from "./files/menuItem";
import { atName } from "./format";
import { isOwnWorkspace, railGroup } from "./rail";
import { selectedContext, type ConsoleData } from "./types";
import { useWorkspaceIcons } from "./useWorkspaceIcons";
import { WorkspaceMark } from "./WorkspaceMark";

/**
 * The account button at the foot of the sidebar, and the workspace switcher
 * behind it.
 *
 * ## Why it is at the bottom now
 *
 * It was a chip at the leading edge of the title bar, naming the open
 * workspace, with a row of recent-workspace marks and a chevron at the foot of
 * the file tree opening the same menu. The owner asked for Discord's shape
 * instead (2026-09-26): one button at the bottom left carrying *you* — your
 * avatar and name, with the workspace you are in under it — that opens a card
 * holding everything else. So the chip and the foot row are gone and this is
 * the one door on a pointer layout. The breadcrumb's head still names the
 * workspace you are in, so nothing that said "where am I" was lost.
 *
 * ## A phone draws the same list as a bottom sheet
 *
 * `trigger="phone"` is the top-left account slot of the phone shell (owner,
 * 2026-09-27, the phone artboards, screen 9): your avatar, or — for the
 * homepage's visitor — a "Sign in" pill in the same place. Pressing it opens
 * these same rows as a bottom sheet (the shared `Menu`): your workspaces with
 * the current one ticked, New workspace, Meetings, Settings, Sign out; for a
 * visitor, Sign in and Create workspace. It replaced two things that had
 * forked: the phone's own `AccountBlock` menu (Meetings, Settings, Sign out)
 * and the chip row of workspaces above the path (`ContextStrip`), since
 * switching workspaces lives here now.
 *
 * ## What it keeps
 *
 * `railGroup` is still the source of the list — your personal workspace
 * pinned first and marked "yours", everything after it in the order the
 * control plane sent (§1464). Every row and every condition on it is the one
 * the title-bar chip had: Meetings, "Claim your @name", New workspace,
 * Settings, Leave on a workspace you do not own, Sign out. Only the container
 * changed.
 *
 * ## Two triggers, one list
 *
 * `"row"` is the full button at the foot of the file tree. `"avatar"` is the
 * same menu behind your avatar alone, which `AppFrame` puts at the leading end
 * of the status bar whenever the tree is folded away or the route has none —
 * without it, folding the tree would take the only sign-out with it. A prop
 * rather than a second component, because the list behind it is the part that
 * must not fork: every row is conditional, and two copies is how one of them
 * ends up with a condition the other lost.
 */
export type SwitcherMenuId =
  | `ctx:${string}`
  | "meetings"
  | "claim"
  | "new"
  | "settings"
  | "leave"
  | "signout"
  | "feedback"
  | "signin"
  | "signup"
  | "app"
  | "whatsnew";

export function SwitcherMenu({
  data,
  label,
  onOpenContext,
  onOpenMeetings,
  onClaimContext,
  onNewWorkspace,
  onOpenSettings,
  onLeaveContext,
  onSignOut,
  onSignIn,
  onCreateAccount,
  onOpenApp,
  whatsNew,
  trigger = "row",
}: {
  data: ConsoleData;
  /** The workspace you are in, as `@name` — the button's second line. */
  label: string;
  onOpenContext: (slug: string) => void;
  onOpenMeetings?: () => void;
  onClaimContext?: () => void;
  onNewWorkspace?: () => void;
  onOpenSettings?: () => void;
  /**
   * Leave the context you are in. Omitted where there is nothing to leave —
   * `leaveWorkspace` refuses an owner (`OWNER_CANNOT_LEAVE`), so the caller
   * decides whether it applies at all. Only ever the *current* context: a list
   * of workspaces each with a destructive row beside it is a menu you stop
   * reading.
   */
  onLeaveContext?: () => void;
  onSignOut?: () => void;
  /** The homepage's visitor, who has no account to sign out of. */
  onSignIn?: () => void;
  onCreateAccount?: () => void;
  /** …or who is signed in and reading it: the way back to their own. */
  onOpenApp?: () => void;
  /**
   * The newest devlog week, when there is one to show: a row after Settings,
   * with a dot while it is unread (`whatsNew/`). Omitted for the homepage's
   * visitor, who has the devlog page in the sidebar already.
   */
  whatsNew?: { week: number; unread: boolean; onOpen: () => void };
  /**
   * `"phone"`: the top-left account slot, opening a bottom sheet — see the
   * header. A visitor who is not signed in sees a "Sign in" pill there.
   */
  trigger?: "row" | "avatar" | "phone";
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<AccountCardAnchor | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const iconFor = useWorkspaceIcons();
  const current = selectedContext(data) ?? undefined;

  /*
    `offerOwnContext` decides whether the claim is on offer at all — the prop
    only says whether this caller can perform it. `creatable` is the caller's
    answer too: the landing page mounts a picture of the console with nowhere
    to send anybody, so "New workspace" is offered exactly where there is a
    handler for it.
  */
  const claimable =
    onClaimContext !== undefined &&
    offerOwnContext({ contexts: data.contexts, loading: data.loading });
  const group = railGroup({
    contexts: data.contexts,
    claimable,
    creatable: onNewWorkspace !== undefined,
  });

  /*
    Something moved in a workspace you are not looking at. The dot hangs off
    each one's mark in the card, and once off your avatar so it is visible
    with the card closed — the job the foot row's marks used to do.
  */
  const elsewhere = group.contexts.some(
    (context) => context.hasNewActivity === true && context.slug !== current?.slug,
  );
  // The avatar's dot also means an unread week of What's new.
  const dotted = elsewhere || whatsNew?.unread === true;

  const workspaces: AccountCardRow[] = [
    /*
      The claim entry takes the **pinned top slot**, which is `railGroup`'s own
      rule: it is the placeholder for exactly the row that would be there.
    */
    ...(group.claim && onClaimContext
      ? [{ id: "claim", label: "Claim your @name", leading: <Icon name="plus" size={14} />, testID: "switcher-claim" }]
      : []),
    ...group.contexts.map((context) => ({
      id: `ctx:${context.slug}`,
      label: atName(context.slug),
      /*
        Said, not just drawn: a dot only sighted people get is the failure
        `ContextStrip`'s own rule names.
      */
      accessibilityLabel:
        context.hasNewActivity && context.slug !== current?.slug
          ? `${atName(context.slug)}, which has changed`
          : undefined,
      /*
        `isOwnWorkspace` rather than `pinned`: `pinned` is the read-only demo
        workspace the control plane appends, and "yours" belongs on the
        personal workspace you own.
      */
      detail: isOwnWorkspace(context) ? "yours" : undefined,
      leading: (
        <View style={styles.markSlot}>
          <WorkspaceMark label={atName(context.slug)} tone={context.status} icon={iconFor(context)} />
          {context.hasNewActivity && context.slug !== current?.slug ? (
            <View style={styles.newDot} aria-hidden />
          ) : null}
        </View>
      ),
      checked: context.slug === current?.slug,
      testID: `switcher-context-${context.slug}`,
    })),
    ...(group.create && onNewWorkspace
      ? [{ id: "new", label: "New workspace", leading: <Icon name="plus" size={14} />, testID: "switcher-new" }]
      : []),
  ];

  const places: AccountCardRow[] = [
    ...(onOpenMeetings
      ? [{ id: "meetings", label: "Meetings", leading: <Icon name="calendar" size={14} />, testID: "switcher-meetings" }]
      : []),
    ...(onOpenSettings
      ? [{ id: "settings", label: "Settings", leading: <Icon name="gear" size={14} />, testID: "switcher-settings" }]
      : []),
    /*
      Signed in only — `onSignOut` is the card's own word for that — and only
      where this build can send a report at all. The phone's way in, since its
      top bar has no room for the bug button.
    */
    ...(onSignOut && canSendFeedback()
      ? [{ id: "feedback", label: "Send feedback", leading: <Icon name="bug" size={14} />, testID: "switcher-feedback" }]
      : []),
    ...(whatsNew
      ? [{
          id: "whatsnew",
          label: "What's new",
          detail: `week ${whatsNew.week}`,
          accessibilityLabel: whatsNew.unread ? `What's new, week ${whatsNew.week}, unread` : undefined,
          badge: whatsNew.unread,
          leading: <Icon name="sparkle" size={14} />,
          testID: "switcher-whats-new",
        }]
      : []),
  ];

  const exits: AccountCardRow[] = [
    ...(onLeaveContext
      ? [{ id: "leave", label: `Leave ${label}`, danger: true, testID: "switcher-leave" }]
      : []),
    ...(onOpenApp
      ? [{ id: "app", label: "Open your workspaces", testID: "switcher-open-app" }]
      : []),
    ...(onSignIn
      ? [{ id: "signin", label: "Sign in or join", testID: "switcher-sign-in" }]
      : []),
    /*
      "Create workspace", which is what the homepage's own link says ("create a
      workspace") and what signing up actually makes — the phone artboards'
      word (2026-09-27). The testID is unchanged.
    */
    ...(onCreateAccount
      ? [{ id: "signup", label: "Create workspace", leading: <Icon name="plus" size={14} />, testID: "switcher-create-account" }]
      : []),
    ...(onSignOut
      ? [{ id: "signout", label: "Sign out", leading: <Icon name="signOut" size={14} />, danger: true, testID: "switcher-sign-out" }]
      : []),
  ];

  const sections: AccountCardSection[] = [
    { key: "workspaces", rows: workspaces },
    { key: "places", rows: places },
    { key: "exits", rows: exits },
  ];

  const open = (event: GestureResponderEvent) => {
    /*
      Opened at the press point at once, then moved onto the button's own box.
      `measureInWindow` answers asynchronously on the web, and a card that
      waited for it would be a press that visibly did nothing for a frame.
    */
    const { pageX, pageY } = event.nativeEvent;
    setAnchor({ x: pageX, y: pageY, width: 0, height: 0 });
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor((was) => (was === null ? was : { x, y, width, height }));
    });
  };

  const select = (id: string) => {
    setAnchor(null);
    setSheetOpen(false);
    if (id.startsWith("ctx:")) onOpenContext(id.slice(4));
    else if (id === "meetings") onOpenMeetings?.();
    else if (id === "claim") onClaimContext?.();
    else if (id === "new") onNewWorkspace?.();
    else if (id === "settings") onOpenSettings?.();
    else if (id === "leave") onLeaveContext?.();
    else if (id === "signout") onSignOut?.();
    else if (id === "feedback") openFeedback("menu");
    else if (id === "signin") onSignIn?.();
    else if (id === "signup") onCreateAccount?.();
    else if (id === "app") onOpenApp?.();
    else if (id === "whatsnew") whatsNew?.onOpen();
  };

  if (trigger === "phone") {
    /*
      A visitor who is not signed in: the slot says what it offers. This is
      the one call to action the phone's top bar carries, and it is in the
      account slot rather than beside the note's own buttons — the owner's
      rule that the top bar has no call to action of its own (websites.md).
    */
    const signedOut = onSignIn !== undefined;
    return (
      <>
        <PressRow
          accessibilityLabel={
            signedOut
              ? "Sign in or join the waitlist"
              : `${data.viewer.name} — account menu${elsewhere ? ", another workspace has changed" : ""}${
                  whatsNew?.unread ? ", what's new is unread" : ""
                }`
          }
          onPress={() => setSheetOpen(true)}
          radius={radii.pill}
          style={signedOut ? styles.signInTarget : styles.phoneTarget}
          hoverStyle={styles.hover}
          ariaHasPopup="menu"
          ariaExpanded={sheetOpen}
          testID="account-menu"
        >
          {signedOut ? (
            <View style={styles.signInPill} testID="account-sign-in-pill">
              <Text variant="rowTitle" style={styles.signInText}>
                Sign in
              </Text>
            </View>
          ) : (
            <View style={styles.markSlot}>
              <Avatar initial={data.viewer.initial} />
              {dotted ? (
                <View style={[styles.newDot, styles.avatarDot]} aria-hidden testID="account-switcher-activity" />
              ) : null}
            </View>
          )}
        </PressRow>
        {sheetOpen ? (
          <Menu<string>
            items={sheetItems(sections)}
            title={data.viewer.name}
            titleDetail={data.viewer.detail}
            onSelect={select}
            onDismiss={() => setSheetOpen(false)}
          />
        ) : null}
      </>
    );
  }

  const avatar = (
    <View style={styles.markSlot}>
      <Avatar initial={data.viewer.initial} size={trigger === "row" ? 28 : 18} />
      {dotted ? (
        <View style={[styles.newDot, styles.avatarDot]} aria-hidden testID="account-switcher-activity" />
      ) : null}
    </View>
  );

  return (
    <>
      <View ref={triggerRef} style={trigger === "row" ? styles.foot : null} testID="account-foot">
        <PressRow
          accessibilityLabel={`${data.viewer.name}, in ${label}: workspaces and account${
            elsewhere ? ", another workspace has changed" : ""
          }${whatsNew?.unread ? ", what's new is unread" : ""}`}
          onPress={open}
          radius={radii.md}
          style={trigger === "row" ? styles.identity : styles.avatarOnly}
          hoverStyle={styles.hover}
          ariaHasPopup="menu"
          ariaExpanded={anchor !== null}
          testID="account-switcher"
        >
          {avatar}
          {trigger === "row" ? (
            <View style={styles.names}>
              <Text variant="rowTitle" numberOfLines={1}>
                {data.viewer.name}
              </Text>
              <Text variant="treeMeta" numberOfLines={1}>
                {label}
              </Text>
            </View>
          ) : null}
          {trigger === "row" ? (
            <Icon name="chevronUp" size={12} color={colors.chromeMuted} />
          ) : null}
        </PressRow>
      </View>

      {anchor === null ? null : (
        <AccountCard
          anchor={anchor}
          name={data.viewer.name}
          detail={data.viewer.detail}
          initial={data.viewer.initial}
          sections={sections}
          onSelect={select}
          onDismiss={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/**
 * The card's sections as one list for the phone's sheet: a rule between
 * groups, and the dot a sighted person sees on a changed workspace said in
 * words, since a sheet row has no mark slot for it.
 */
export function sheetItems(sections: readonly AccountCardSection[]): MenuItem<string>[] {
  const items: MenuItem<string>[] = [];
  for (const section of sections) {
    section.rows.forEach((row, index) => {
      const changed =
        row.badge !== true && row.accessibilityLabel !== undefined && row.accessibilityLabel !== row.label;
      const detail = [row.detail, changed ? "changed" : undefined, row.badge ? "new" : undefined]
        .filter(Boolean)
        .join(" · ");
      items.push({
        id: row.id,
        label: row.label,
        ...(detail === "" ? {} : { detail }),
        ...(row.leading === undefined ? {} : { leading: row.leading }),
        ...(row.checked === undefined ? {} : { checked: row.checked }),
        ...(row.danger === true ? { danger: true } : {}),
        ...(index === 0 && items.length > 0 ? { separatorBefore: true } : {}),
        testID: row.testID,
      });
    });
  }
  return items;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /** A hairline above, and the panel's own surface: the bottom of the tree. */
    foot: {
      height: layout.accountFootHeight,
      justifyContent: "center",
      paddingHorizontal: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    identity: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x2,
      paddingVertical: space.x1,
    },
    names: { flex: 1, minWidth: 0, gap: 1 },
    avatarOnly: {
      width: 26,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    hover: { backgroundColor: colors.surface3 },
    /** The phone's avatar: a 26pt mark inside a 44pt target. */
    phoneTarget: {
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      alignItems: "center",
      justifyContent: "center",
    },
    /** The visitor's pill, in the same slot, at the same touch height. */
    signInTarget: {
      minHeight: layout.minTouchTarget,
      justifyContent: "center",
    },
    signInPill: {
      paddingHorizontal: space.x3,
      paddingVertical: 6,
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      boxShadow: "0 2px 8px rgba(0,0,0,.08)",
    },
    signInText: { fontWeight: "600" },
    markSlot: { position: "relative" },
    /**
     * The activity dot, straddling the mark's leading top corner, ringed in
     * the surface behind it so it reads as a mark *on* the square.
     */
    newDot: {
      position: "absolute",
      top: -2,
      left: -2,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
      borderWidth: 1.5,
      borderColor: colors.chromeSurface,
    },
    avatarDot: { left: undefined, right: -2, width: 8, height: 8, borderRadius: 4 },
  });
