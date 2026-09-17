import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Dot, type DotTone } from "../design/components/Dot";
import { Icon } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { WorkspaceMark } from "./WorkspaceMark";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { radii, space } from "../design/tokens";
import type { MenuItem } from "./files/menu";
import { offerOwnContext } from "../onboarding/route";
import { isOwnWorkspace, railGroup } from "./rail";
import type { ConsoleData } from "./types";

/**
 * The workspace switcher, and everything the rail used to be a column for.
 *
 * ## Why this exists
 *
 * The console drew three columns: a 216pt rail of workspaces and app sections,
 * a 260pt file tree, and the note. The design canvas draws two — the tree and
 * the page — and puts the rail's contents behind the name already sitting in
 * the title bar. Five workspaces and four destinations do not earn a permanent
 * column; they earn a menu under the name you already look at to know whose
 * notes are open.
 *
 * That reverses two durable decisions and the reversal is recorded rather than
 * smuggled: see `docs/decisions/app-and-console.md`, "The rail folds into the
 * switcher, and the column it occupied goes to the note".
 *
 * ## What it keeps
 *
 * `railGroup` is unchanged and still the source of the list — one group, the
 * personal workspace pinned first, marked "yours", everything after it in the
 * order the control plane sent. That decision (§1464) is about *ordering* and
 * survives the move intact; only the container changed. `railGroup.test.ts`
 * still covers it, and it still passes, which is the point of not rewriting it.
 *
 * ## What it does not carry, and why that took looking
 *
 * The first draft gave it Map and Connections. The rail has not had those
 * since they became "facts about a context rather than places inside one" and
 * moved into the context's own page. The rail carried that reasoning in a
 * comment beginning "This is not the `App` group coming back", and it moved
 * here with the list when `ConsoleRail.tsx` was deleted: a group of app-level
 * destinations is not something this menu grows back. It *does* carry
 * Meetings, "Claim your @name" and "New workspace", which the first draft
 * dropped.
 *
 * That is the shape of this fold's real cost, and it is why this component
 * lands before the fold does: the rail is five kinds of destination, not one
 * list, and 51 assertions across 8 suites name the rail as the container they
 * live in. Those are §1464's "tests that fail if it is reversed" doing exactly
 * what they were written to do.
 *
 * Settings, Leave and sign-out follow the workspaces after a rule, because
 * "whose notes am I in" and "what can I do about it" are two questions and a
 * menu that runs them together is a menu you have to read twice.
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
  tone,
  onOpenContext,
  onOpenMeetings,
  onClaimContext,
  onNewWorkspace,
  onOpenSettings,
  onLeaveContext,
  onSignOut,
}: {
  data: ConsoleData;
  label: string;
  tone: DotTone;
  onOpenContext: (slug: string) => void;
  onOpenMeetings?: () => void;
  onClaimContext?: () => void;
  onNewWorkspace?: () => void;
  onOpenSettings?: () => void;
  /**
   * Leave the context you are in. Omitted where there is nothing to leave.
   *
   * **This row is the fold's one real cost, paid rather than lost.** Leaving
   * somebody else's workspace was a right-click on the rail's row, through
   * `ContextRowMenu` — and a menu row has no second menu behind it, so the
   * pointer layout would have had no door out of a shared context at all. The
   * phone keeps its own: a long press on the strip's pill, the same component,
   * unchanged.
   *
   * Only ever the *current* context, which is what keeps this one row rather
   * than one per workspace: "leave" is a verb about where you are standing,
   * and a list of five workspaces each with a destructive row beside it is a
   * menu you stop reading. The caller decides whether it applies at all —
   * `leaveWorkspace` refuses an owner (`OWNER_CANNOT_LEAVE`), so a row offered
   * on your own workspace is a press whose only outcome is an error.
   */
  onLeaveContext?: () => void;
  onSignOut?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  /*
    The same call the rail makes, with the same two offers, so the list and
    both conditions stay in one place. `offerOwnContext` decides whether the
    claim is on offer at all — the prop only says whether this caller can
    perform it. That split is `offerOwnContext`'s to state and not this
    component's to restate differently; the rail held the same line.
  */
  const claimable =
    onClaimContext !== undefined &&
    offerOwnContext({ contexts: data.contexts, loading: data.loading });
  /*
    `creatable` is the caller's answer, not a constant: the landing page mounts
    a picture of the console with nowhere to send anybody, so "New workspace"
    is offered exactly where there is a handler for it. `railGroup` defaults it
    to `false` for that reason and this passes the real one.
  */
  const group = railGroup({
    contexts: data.contexts,
    claimable,
    creatable: onNewWorkspace !== undefined,
  });

  const items: MenuItem<SwitcherMenuId>[] = [
    ...(onOpenMeetings
      ? [
          {
            id: "meetings" as SwitcherMenuId,
            label: "Meetings",
            testID: "switcher-meetings",
          },
        ]
      : []),
    /*
      The claim entry takes the **pinned top slot**, which is `railGroup`'s own
      rule rather than this menu's: it is the placeholder for exactly the row
      that would be there, so it cannot be drawn under the workspaces it stands
      in for. `group.claim` is the second lock on whether it applies at all.
    */
    ...(group.claim && onClaimContext
      ? [
          {
            id: "claim" as SwitcherMenuId,
            label: "Claim your @name",
            testID: "switcher-claim",
          },
        ]
      : []),
    ...group.contexts.map((context) => ({
      id: `ctx:${context.slug}` as SwitcherMenuId,
      label: `@${context.slug}`,
      /*
        The ownership mark, and it is `isOwnWorkspace` rather than `pinned`.
        `pinned` is the *read-only demo workspace the control plane appends*,
        held to the end of the list; "yours" belongs on the personal workspace
        you own, which `railGroup` holds to the front. The rail drew them as
        two different things and so does this.
      */
      detail: isOwnWorkspace(context) ? "yours" : undefined,
      leading: <Dot tone={context.kind === "personal" ? "ok" : "neutral"} />,
      testID: `switcher-context-${context.slug}`,
    })),
    ...(group.create && onNewWorkspace
      ? [
          {
            id: "new" as SwitcherMenuId,
            label: "New workspace",
            testID: "switcher-new",
          },
        ]
      : []),
    ...(onOpenSettings
      ? [
          {
            id: "settings" as SwitcherMenuId,
            label: "Settings…",
            separatorBefore: true,
            testID: "switcher-settings",
          },
        ]
      : []),
    ...(onLeaveContext
      ? [
          {
            id: "leave" as SwitcherMenuId,
            label: `Leave ${label}`,
            danger: true,
            testID: "switcher-leave",
          },
        ]
      : []),
    ...(onSignOut
      ? [
          {
            id: "signout" as SwitcherMenuId,
            label: "Sign out",
            danger: true,
            separatorBefore: true,
            testID: "switcher-sign-out",
          },
        ]
      : []),
  ];

  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel="Switch workspace"
        testID="frame-switcher"
        onPress={(event) => {
          const { pageX, pageY } = event.nativeEvent;
          setAnchor({ x: pageX, y: pageY });
        }}
        style={styles.chip}
      >
        <WorkspaceMark label={label} tone={tone} />
        <Text variant="wsSwitch" numberOfLines={1}>
          {label}
        </Text>
        {/*
          A chevron, which is what a disclosure control shows.

          It was `collapse` — the file tree's collapse-all mark, a pane with
          only its top band left open — at 12pt in a 28pt chip, where it read
          as a small empty rectangle beside the workspace name. Nobody drew
          that on purpose; the name is close enough to "collapsed" to have gone
          in without a second look, and the glyph is small enough to survive
          one.
        */}
        <View style={styles.chevron}>
          <Icon name="chevronDown" size={10} color={colors.chromeMuted} />
        </View>
      </Pressable>

      {anchor === null ? null : (
        <Menu<SwitcherMenuId>
          items={items}
          anchor={anchor}
          title={label}
          onSelect={(id) => {
            setAnchor(null);
            if (id.startsWith("ctx:")) onOpenContext(id.slice(4));
            else if (id === "meetings") onOpenMeetings?.();
            else if (id === "claim") onClaimContext?.();
            else if (id === "new") onNewWorkspace?.();
            else if (id === "settings") onOpenSettings?.();
            else if (id === "leave") onLeaveContext?.();
            else if (id === "signout") onSignOut?.();
          }}
          onDismiss={() => setAnchor(null)}
        />
      )}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /**
     * The chip has a resting fill now, and that is the point of it.
     *
     * It was a transparent row of words that happened to be pressable, which
     * is how a title bar ends up reading as a sentence rather than as
     * controls. `chipFill` is the canvas's answer and the same wash the search
     * box and the tree's new-note button wear.
     *
     * Asymmetric padding: 6 in front of an 18pt mark, 8 after the chevron. A
     * flat 8 leaves the mark looking inset and the chip looking off-centre,
     * which is what "6 then 8" in the canvas is correcting.
     */
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      height: 28,
      paddingLeft: 6,
      paddingRight: space.x2,
      borderRadius: radii.sm,
      backgroundColor: colors.chipFill,
      minWidth: 0,
    },
    /** Chrome's grey, not a label's — see `chromeMuted`. */
    chevron: { opacity: 0.9 },
  });
