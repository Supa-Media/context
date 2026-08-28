import type { ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { PressRow } from "../design/components/Button";
import { Dot } from "../design/components/Dot";
import { Text } from "../design/components/Text";
import { gradient } from "../design/css";
import { colors, layout, radii, space } from "../design/tokens";
import { offerOwnContext } from "../onboarding/route";
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
}: {
  data: ConsoleData;
  route: ConsoleRoute;
  mode: "full" | "icons" | "sheet";
  onNavigate: (route: ConsoleRoute) => void;
  /** The account block. Passed in so the rail never imports auth. */
  account: ReactNode;
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
}) {
  const icons = mode === "icons";
  const touch = mode === "sheet";
  const claimable = onClaimContext !== undefined && offerOwnContext({
    contexts: data.contexts,
    loading: data.loading,
  });

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
              touch={touch}
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
              touch={touch}
              accessibilityLabel={`Open ${atName(context.slug)}`}
              selected={route.kind === "context" && route.slug === context.slug}
              onPress={() => onNavigate(selectContextRoute(context.slug))}
              leading={<Dot tone={context.status} />}
            />
          ))}
          {/*
            The way to have a context of your own, for somebody who does not.

            It sits *in* the Contexts group and last, under the contexts you
            can already reach, because that is the question it answers: these
            are the ones you can open, and none of them is yours. Above the
            group, or in App, it would read as a verb about the application
            rather than a gap in this list.

            It is drawn accented rather than as another quiet row on purpose.
            The person this is for arrived through somebody else's invitation
            and has no reason to suspect the product does anything else; a row
            that matched its neighbours would be discoverable only by reading
            every word in the rail. This is the one entry that has to be
            noticed, and it stops existing the moment it is used.
          */}
          {claimable ? (
            <RailEntry
              label="Claim your @name"
              glyph="+"
              icons={icons}
              touch={touch}
              accessibilityLabel="Claim your name and create your own context"
              onPress={onClaimContext!}
              style={styles.claim}
              labelStyle={styles.claimLabel}
              testID="rail-claim-context"
            />
          ) : null}
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
  touch = false,
  selected,
  onPress,
  leading,
  role = "button",
  accessibilityLabel,
  style,
  labelStyle,
  testID,
}: {
  label: string;
  glyph: string;
  icons: boolean;
  /** Phone sizing: the row clears `layout.minTouchTarget` on both axes. */
  touch?: boolean;
  selected?: boolean;
  onPress: () => void;
  leading?: ReactNode;
  role?: "button" | "tab";
  accessibilityLabel?: string;
  /** Painted over the sizing style, so a mode never loses its target size. */
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  testID?: string;
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
      style={[icons ? styles.entryIcons : touch ? styles.entryTouch : styles.entry, style]}
      hoverStyle={styles.entryHover}
      selectedStyle={styles.entryOn}
      testID={testID}
    >
      {icons ? (
        <Text style={[styles.glyph, selected && styles.glyphOn, labelStyle]} aria-hidden>
          {glyph}
        </Text>
      ) : (
        <>
          {leading}
          <Text
            variant="rail"
            style={[selected ? styles.entryOnLabel : undefined, labelStyle]}
            numberOfLines={1}
          >
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
  touch = false,
}: {
  name: string;
  detail?: string;
  initial: string;
  onSignOut: () => void;
  compact?: boolean;
  /** Phone sizing: sign-out clears `layout.minTouchTarget` on both axes. */
  touch?: boolean;
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
