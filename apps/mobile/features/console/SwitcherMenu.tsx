import { useRef, useState } from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";

import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { layout, radii, space } from "../design/tokens";
import { offerOwnContext } from "../onboarding/route";
import { Avatar } from "./AccountBlock";
import {
  AccountCard,
  type AccountCardAnchor,
  type AccountCardRow,
  type AccountCardSection,
} from "./AccountCard";
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
 * A phone is unchanged: it has no sidebar, its workspaces are `NavBand`'s strip
 * and its account is `AccountBlock` in the top row.
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
  | "signout";

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
  trigger?: "row" | "avatar";
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<AccountCardAnchor | null>(null);
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
  ];

  const exits: AccountCardRow[] = [
    ...(onLeaveContext
      ? [{ id: "leave", label: `Leave ${label}`, danger: true, testID: "switcher-leave" }]
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
    if (id.startsWith("ctx:")) onOpenContext(id.slice(4));
    else if (id === "meetings") onOpenMeetings?.();
    else if (id === "claim") onClaimContext?.();
    else if (id === "new") onNewWorkspace?.();
    else if (id === "settings") onOpenSettings?.();
    else if (id === "leave") onLeaveContext?.();
    else if (id === "signout") onSignOut?.();
  };

  const avatar = (
    <View style={styles.markSlot}>
      <Avatar initial={data.viewer.initial} size={trigger === "row" ? 28 : 18} />
      {elsewhere ? (
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
          }`}
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
