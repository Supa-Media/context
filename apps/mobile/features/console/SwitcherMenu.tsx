import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Dot, type DotTone } from "../design/components/Dot";
import { Icon } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { radii, space } from "../design/tokens";
import type { MenuItem } from "./files/menu";
import { offerOwnContext } from "../onboarding/route";
import { railGroup } from "./rail";
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
 * moved into the context's own page — `ConsoleRail` says so in a comment
 * beginning "This is not the `App` group coming back". It *does* carry
 * Meetings, "Claim your @name" and "New workspace", which the first draft
 * dropped.
 *
 * That is the shape of this fold's real cost, and it is why this component
 * lands before the fold does: the rail is five kinds of destination, not one
 * list, and 51 assertions across 8 suites name the rail as the container they
 * live in. Those are §1464's "tests that fail if it is reversed" doing exactly
 * what they were written to do.
 *
 * Settings and sign-out follow the workspaces after a rule, because "whose
 * notes am I in" and "where else can I go" are two questions and a menu that
 * runs them together is a menu you have to read twice.
 */
export type SwitcherMenuId =
  | `ctx:${string}`
  | "meetings"
  | "claim"
  | "new"
  | "settings"
  | "signout";

export function SwitcherMenu({
  data,
  label,
  kind,
  tone,
  onOpenContext,
  onOpenMeetings,
  onClaimContext,
  onNewWorkspace,
  onOpenSettings,
  onSignOut,
}: {
  data: ConsoleData;
  label: string;
  kind: string;
  tone: DotTone;
  onOpenContext: (slug: string) => void;
  onOpenMeetings?: () => void;
  onClaimContext?: () => void;
  onNewWorkspace?: () => void;
  onOpenSettings?: () => void;
  onSignOut?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  /*
    The same call the rail makes, with the same two offers, so the list and
    both conditions stay in one place. `offerOwnContext` decides whether the
    claim is on offer at all — the prop only says whether this caller can
    perform it — which is the rule `ConsoleRail` states and neither of us gets
    to restate differently.
  */
  const claimable =
    onClaimContext !== undefined &&
    offerOwnContext({ contexts: data.contexts, loading: data.loading });
  const group = railGroup({ contexts: data.contexts, claimable });

  const items: MenuItem<SwitcherMenuId>[] = [
    ...(onOpenMeetings ? [{ id: "meetings" as SwitcherMenuId, label: "Meetings" }] : []),
    ...group.contexts.map((context) => ({
      id: `ctx:${context.slug}` as SwitcherMenuId,
      label: `@${context.slug}`,
      detail: context.pinned === true ? "yours" : undefined,
      leading: <Dot tone={context.kind === "personal" ? "ok" : "neutral"} />,
    })),
    ...(group.claim && onClaimContext
      ? [{ id: "claim" as SwitcherMenuId, label: "Claim your @name" }]
      : []),
    ...(group.create && onNewWorkspace
      ? [{ id: "new" as SwitcherMenuId, label: "New workspace" }]
      : []),
    ...(onOpenSettings
      ? [{ id: "settings" as SwitcherMenuId, label: "Settings…", separatorBefore: true }]
      : []),
    ...(onSignOut
      ? [{ id: "signout" as SwitcherMenuId, label: "Sign out", danger: true, separatorBefore: true }]
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
        <Dot tone={tone} />
        <Text variant="wsSwitch" numberOfLines={1}>
          {label}
        </Text>
        {kind === "" ? null : (
          <Text variant="wsSwitch" style={styles.kind}>
            {kind}
          </Text>
        )}
        <View style={styles.chevron}>
          <Icon name="collapse" size={12} />
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
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      height: 28,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      minWidth: 0,
    },
    kind: { color: colors.muted },
    chevron: { opacity: 0.6 },
  });
