import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Menu } from "../design/components/Menu";
import { Text } from "../design/components/Text";
import { layout, pointerType as t, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { MenuItem } from "./files/menu";

/**
 * Who you are signed in as, and the way out.
 *
 * Takes plain values and one callback so it imports no auth and no router —
 * which is what lets it be mounted in a test, and what keeps the landing
 * page's copy of the console honest.
 *
 * **It was the foot of the rail, and the rail is gone** (see
 * `features/app/frame.ts`). Both forms outlived it, because neither was ever
 * about the column: `compact` is pinned in `AppFrame`'s `accountSlot` on a
 * phone, and the full row is what `SwitcherMenu` puts your own name and the
 * way out on under a pointer.
 *
 * ## `compact` is the phone's whole sign-out, so it is a real target
 *
 * The two forms used to differ in weight: the full one was the rail's foot and
 * the compact one was a mark in a corner, drawn where there was no room for a
 * name. On a phone this compact form is **the only sign-out control on that
 * density**, and it is what `signOutTouch` says of the other one: the one
 * control somebody reaches for deliberately and must not miss.
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
    <View style={styles.avatar} aria-hidden>
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
   * `compact`, where this button sits in whatever slot holds it rather than
   * in a fixed corner. Measured at press time rather than carried from
   * layout, the same way `Explorer.tsx` and `TabStrip.tsx` capture a row's
   * position for their own context menus: a value computed once at render and
   * reused across presses would still be right the first time and stale after
   * anything around it scrolls.
   */
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(
    undefined,
  );

  const items: MenuItem<AccountMenuActionId>[] = [];
  if (onOpenSettings !== undefined) {
    items.push({
      id: "settings",
      label: "Settings…",
      testID: "account-settings",
    });
  }
  items.push({
    id: "signOut",
    label: "Sign out",
    danger: true,
    testID: "account-sign-out",
  });

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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    entryHover: { backgroundColor: colors.surface2 },
    /**
     * The pinned account mark, and the only sign-out a phone has.
     *
     * `padding: 4` around a 26pt mark is 34, which is `accountAvatar` and is
     * **under `minTouchTarget`** — legal for a mark and not for the pressable
     * around it, which is the distinction that token draws and this style was on
     * the wrong side of. Square on both axes so the pill radius reads as a
     * circle rather than as a stadium.
     */
    accountPinned: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
    },
    accountRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    accountText: { flex: 1, minWidth: 0 },
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
      /* See `ConsoleShell`'s avatar: one hue, flat, no retired defaults. */
      backgroundColor: colors.accent,
    },
    avatarInitial: { fontSize: t.label, fontWeight: "700", color: colors.ink },
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
    signOutGlyph: { fontSize: t.ui, color: colors.muted },
  });
