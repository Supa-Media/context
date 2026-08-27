import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Dot } from "../design/components/Dot";
import { Text } from "../design/components/Text";
import { gradient } from "../design/css";
import { colors, radii, space } from "../design/tokens";
import { atName } from "./format";
import { APP_SECTIONS, selectContextRoute, type ConsoleRoute } from "./nav";
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
 * ## Two widths, one rail
 *
 * `icons` is not a different component. A medium window pays for the explorer
 * column with the rail's labels, and a wide window can be collapsed to the same
 * state deliberately, so both arrive here as a mode. Every entry keeps its
 * accessibility label at both widths — a rail that becomes a row of unlabelled
 * glyphs to a screen reader is not collapsed, it is broken.
 */
export function ConsoleRail({
  data,
  route,
  mode,
  onNavigate,
  account,
}: {
  data: ConsoleData;
  route: ConsoleRoute;
  mode: "full" | "icons";
  onNavigate: (route: ConsoleRoute) => void;
  /** The account block. Passed in so the rail never imports auth. */
  account: ReactNode;
}) {
  const icons = mode === "icons";

  return (
    <View style={styles.rail}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, icons && styles.contentIcons]}
        showsVerticalScrollIndicator={false}
      >
        <Group heading="App" icons={icons}>
          {APP_SECTIONS.map((section) => (
            <RailEntry
              key={section.key}
              label={section.label}
              glyph={SECTION_GLYPHS[section.key]}
              icons={icons}
              selected={route.kind === "app" && route.section === section.key}
              onPress={() => onNavigate({ kind: "app", section: section.key })}
              role="tab"
            />
          ))}
        </Group>

        <Group heading="Contexts" icons={icons}>
          {data.contexts.length === 0 && !data.loading ? (
            icons ? null : (
              <Text variant="rowSub" style={styles.empty}>
                No contexts yet
              </Text>
            )
          ) : null}
          {data.contexts.map((context) => (
            <RailEntry
              key={context.id}
              label={atName(context.slug)}
              // A context has no glyph of its own, so the initial stands in —
              // the same letter the avatar uses, which is what makes a
              // collapsed rail learnable rather than a row of identical dots.
              glyph={context.slug.slice(0, 1).toUpperCase()}
              icons={icons}
              accessibilityLabel={`Open ${atName(context.slug)}`}
              selected={route.kind === "context" && route.slug === context.slug}
              onPress={() => onNavigate(selectContextRoute(context.slug))}
              leading={<Dot tone={context.status} />}
            />
          ))}
        </Group>
      </ScrollView>

      <View style={[styles.account, icons && styles.accountIcons]}>{account}</View>
    </View>
  );
}

const SECTION_GLYPHS: Record<string, string> = { map: "◈", connections: "⇌" };

function Group({
  heading,
  icons,
  children,
}: {
  heading: string;
  icons: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.group}>
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
  glyph,
  icons,
  selected,
  onPress,
  leading,
  role = "button",
  accessibilityLabel,
}: {
  label: string;
  glyph: string;
  icons: boolean;
  selected?: boolean;
  onPress: () => void;
  leading?: ReactNode;
  role?: "button" | "tab";
  accessibilityLabel?: string;
}) {
  return (
    <PressRow
      // The label survives the collapse. A rail that reads as a row of
      // unlabelled glyphs to a screen reader is broken, not compact.
      accessibilityLabel={accessibilityLabel ?? label}
      role={role}
      selected={selected}
      onPress={onPress}
      radius={radii.md}
      style={icons ? styles.entryIcons : styles.entry}
      hoverStyle={styles.entryHover}
      selectedStyle={styles.entryOn}
    >
      {icons ? (
        <Text style={[styles.glyph, selected && styles.glyphOn]} aria-hidden>
          {glyph}
        </Text>
      ) : (
        <>
          {leading}
          <Text variant="rail" style={selected ? styles.entryOnLabel : undefined} numberOfLines={1}>
            {label}
          </Text>
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
 */
export function AccountBlock({
  name,
  detail,
  initial,
  onSignOut,
  compact = false,
}: {
  name: string;
  detail?: string;
  initial: string;
  onSignOut: () => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <PressRow
        accessibilityLabel={`${name} — sign out`}
        onPress={onSignOut}
        radius={radii.pill}
        style={styles.avatarOnly}
        hoverStyle={styles.entryHover}
      >
        <Avatar initial={initial} />
      </PressRow>
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
      <PressRow
        accessibilityLabel="Sign out"
        onPress={onSignOut}
        radius={radii.md}
        style={styles.signOut}
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
  return (
    <View
      style={[styles.avatar, gradient("linear-gradient(140deg,#3B82F6,#8B5CF6)")]}
      aria-hidden
    >
      <Text style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { paddingVertical: space.x4, paddingHorizontal: space.x3 },
  contentIcons: { paddingHorizontal: space.x2, alignItems: "center" },

  group: { marginBottom: space.x5, gap: 2, alignSelf: "stretch" },
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
  entryHover: { backgroundColor: colors.surface2 },
  entryOn: { backgroundColor: colors.accentDim },
  entryOnLabel: { color: colors.accentText },
  glyph: { color: colors.text2, fontSize: 14 },
  glyphOn: { color: colors.accentText },

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
  avatarOnly: { padding: 4, borderRadius: radii.pill },

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
  signOutHover: { backgroundColor: colors.surface3 },
  signOutGlyph: { fontSize: 13, color: colors.muted },
});
