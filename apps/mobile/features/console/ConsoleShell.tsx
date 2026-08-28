import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { PressRow, WindowDots } from "../design/components/Button";
import { Dot } from "../design/components/Dot";
import { Pill } from "../design/components/Pill";
import { Text } from "../design/components/Text";
import { gradient } from "../design/css";
import { colors, layout, radii } from "../design/tokens";
import { atName } from "./format";
import { APP_SECTIONS, selectContextRoute, type ConsoleRoute } from "./nav";
import { railSections } from "./rail";
import { selectedContext, type ConsoleData } from "./types";
import { tierChipLabel } from "./visibility";

/**
 * The console chrome: title bar, left rail, and the pane body.
 *
 * The rail carries the two scopes rather than one flat list. **App** holds Map
 * and Connections, which span every context you can reach. The contexts
 * themselves split on ownership — **Contexts** for what you own, **Shared with
 * you** for what you were let into (see `rail.ts`) — and picking one navigates
 * *into* it: Browse is where you land, and its settings hang off it. That is
 * not just tidier: a storage binding belongs to a workspace, so "Storage"
 * sitting beside "Map" was claiming a scope it never had.
 *
 * It takes a `ConsoleData` and a route and nothing else, which is what lets the
 * same component serve both the authenticated console and the read-only demo on
 * the landing page.
 */
export function ConsoleShell({
  data,
  route,
  onNavigate,
  children,
  chrome = true,
}: {
  data: ConsoleData;
  route: ConsoleRoute;
  onNavigate: (route: ConsoleRoute) => void;
  children: ReactNode;
  /**
   * Draw the fake application window — traffic-light dots, rounded frame, drop
   * shadow.
   *
   * True on the landing page, where this component is a *picture of the
   * product* sitting inside a marketing page: the frame is what says "this is
   * an app" to somebody who has never seen it. False in the real console, where
   * the browser is already the window. Painting a second set of window controls
   * inside a real one is chrome inside chrome — it reads as an embedded
   * screenshot of the thing you are actually using, and costs a border, a
   * shadow and 27px of title bar for nothing.
   */
  chrome?: boolean;
}) {
  const { width } = useWindowDimensions();
  const narrow = width < layout.narrowBreakpoint;
  const current = selectedContext(data);
  const insideContext = route.kind === "context";

  return (
    <View style={chrome ? styles.console : styles.bare}>
      <View style={[styles.bar, !chrome && styles.barBare]}>
        {chrome ? <WindowDots /> : null}
        <View style={styles.switcher}>
          {insideContext ? (
            <>
              <Dot tone={current?.status ?? "warn"} />
              <Text variant="wsSwitch">{atName(current?.slug ?? route.slug)}</Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {current?.kind ?? ""}
              </Text>
            </>
          ) : (
            // Map and Connections are not inside anything, and a context chip
            // above them would be naming a scope the pane is not in.
            <>
              <Text variant="wsSwitch">All contexts</Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {`${data.contexts.length} reachable`}
              </Text>
            </>
          )}
        </View>
        <View
          style={[styles.avatar, gradient("linear-gradient(140deg,#3B82F6,#8B5CF6)")]}
          accessibilityLabel="Your account"
        >
          <Text style={styles.avatarInitial}>{data.viewer.initial}</Text>
        </View>
      </View>

      <View style={[styles.body, narrow && styles.bodyNarrow]}>
        <View
          style={[styles.rail, narrow && styles.railNarrow]}
          role="navigation"
          aria-label="Console"
        >
          <View style={[styles.railGroup, narrow && styles.railGroupNarrow]}>
            <Text variant="railHead" style={styles.railHead}>
              App
            </Text>
            {APP_SECTIONS.map((section) => (
              <RailButton
                key={section.key}
                label={section.label}
                selected={route.kind === "app" && route.section === section.key}
                onPress={() => onNavigate({ kind: "app", section: section.key })}
                role="tab"
              />
            ))}
          </View>

          {/*
            Own contexts under "Contexts", everything granted under "Shared
            with you", empty sections omitted — the same split, from the same
            function, as the real console's rail. See `rail.ts`. The landing
            page never offers the claim entry: a picture has nowhere to send
            anybody.
          */}
          {railSections({ contexts: data.contexts, claimable: false }).map((section) => (
            <View key={section.key} style={[styles.railGroup, narrow && styles.railGroupNarrow]}>
              <Text variant="railHead" style={styles.railHead}>
                {section.heading}
              </Text>
              {section.key === "own" && data.contexts.length === 0 && !data.loading ? (
                <Text variant="rowSub" style={styles.railEmpty}>
                  No contexts yet
                </Text>
              ) : null}
              {section.contexts.map((context) => (
                <RailButton
                  key={context.id}
                  label={atName(context.slug)}
                  accessibilityLabel={`Open ${atName(context.slug)}`}
                  selected={route.kind === "context" && route.slug === context.slug}
                  onPress={() => onNavigate(selectContextRoute(context.slug))}
                  leading={<Dot tone={context.status} />}
                />
              ))}
            </View>
          ))}
        </View>

        <View style={styles.pane}>{children}</View>
      </View>
    </View>
  );
}

function RailButton({
  label,
  selected,
  onPress,
  leading,
  role = "button",
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  leading?: ReactNode;
  role?: "button" | "tab";
  accessibilityLabel?: string;
}) {
  return (
    <PressRow
      accessibilityLabel={accessibilityLabel ?? label}
      role={role}
      selected={selected}
      onPress={onPress}
      radius={radii.md}
      style={styles.railBtn}
      hoverStyle={styles.railBtnHover}
      selectedStyle={styles.railBtnOn}
    >
      {leading}
      <Text variant="rail" style={selected ? styles.railBtnOnLabel : undefined}>
        {label}
      </Text>
    </PressRow>
  );
}

/**
 * `.panehead` — title, explanatory line, and an optional status pill.
 *
 * The description is **dropped on a narrow screen**, and that is a deliberate
 * edit rather than a responsive afterthought. Measured in Chromium, the title
 * and its two-line explanation cost 95px of an 844px phone viewport — around a
 * ninth of the screen, above every note, every time you open one. On a desktop
 * that paragraph is a useful orientation for somebody seeing the pane for the
 * first time; on a phone it is a paragraph standing between you and the note
 * you just tapped, and the top bar already says which context you are in.
 *
 * The title stays: it is the heading a screen reader navigates by, and losing
 * it would cost the page its structure to save nothing.
 */
export function PaneHead({
  title,
  description,
  trailing,
}: {
  title: string;
  description?: string;
  trailing?: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const narrow = width > 0 && width < layout.narrowBreakpoint;

  return (
    <View style={styles.paneHead}>
      <View style={styles.paneHeadText}>
        <Text variant="paneTitle" role="heading" aria-level={2}>
          {title}
        </Text>
        {description !== undefined && !narrow ? (
          <Text variant="paneSub" style={styles.paneHeadSub}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

/**
 * `team level only` — worn by a pane that is showing somebody else's context.
 *
 * Neutral rather than warn on purpose. Being a member of a context is a normal,
 * correct state, not a fault to be fixed; the warn tone in this console means
 * "something here needs you" and is already spoken for by the storage chip.
 *
 * It renders **nothing at all** for an owner, and nothing while the role is
 * still `undefined` — `visibility.ts` explains why a half-second of "your notes
 * are filtered" is worse than a half-second of silence. A component that can
 * return `null` is what lets every caller mount it unconditionally instead of
 * repeating that rule at each call site, where one of them would eventually get
 * it wrong.
 *
 * The label is the pill's own text, so a screen reader already reads it; the
 * longer `tierSentence` is deliberately not crammed in here as a tooltip, since
 * a tooltip is invisible on a phone. Panes that have room state it in full.
 */
export function TierChip({ role }: { role: string | null | undefined }) {
  const label = tierChipLabel(role);
  if (label === null) return null;
  return (
    <Pill tone="neutral" leading={<Dot tone="neutral" />}>
      {label}
    </Pill>
  );
}

const styles = StyleSheet.create({
  /** `.console` */
  console: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.console,
    overflow: "hidden",
    backgroundColor: colors.surface,
    boxShadow: "0 50px 120px -40px rgba(0,0,0,1), 0 0 0 1px rgba(255,255,255,.03)",
  },
  /**
   * The same console without the window costume.
   *
   * No border, no radius, no drop shadow — in the real console the browser is
   * already the window, and a second frame inside it reads as an embedded
   * screenshot of the app you are currently using. `overflow: hidden` stays:
   * it is what stops a long bucket name or a wide tree scrolling the page
   * sideways.
   */
  bare: {
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  /** `.cbar` */
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface2,
  },
  /** `.wsswitch` */
  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  /** Without the traffic lights the bar has no left inset to balance. */
  barBare: {
    paddingHorizontal: 0,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  switcherKind: { color: colors.muted },
  /** `.avatar` */
  avatar: {
    marginLeft: "auto",
    width: 27,
    height: 27,
    borderRadius: 13.5,
    alignItems: "center",
    justifyContent: "center",
    // Flat fallback for platforms that drop the gradient.
    backgroundColor: "#5F6EF6",
  },
  avatarInitial: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
  },
  /** `.cbody` */
  body: {
    flexDirection: "row",
    minHeight: layout.consoleBodyMinHeight,
  },
  bodyNarrow: {
    flexDirection: "column",
    minHeight: 0,
  },
  /** `.rail` */
  rail: {
    width: layout.railWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    paddingVertical: 15,
    paddingHorizontal: 11,
    backgroundColor: colors.surface,
  },
  railNarrow: {
    width: "100%",
    flexDirection: "row",
    gap: 14,
    borderRightWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  railGroup: { marginBottom: 22 },
  railGroupNarrow: { marginBottom: 0, flexGrow: 0, flexShrink: 0 },
  railHead: { marginBottom: 8, paddingHorizontal: 8 },
  railEmpty: { paddingHorizontal: 9, paddingVertical: 7 },
  /** `.railbtn` */
  railBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    width: "100%",
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: radii.md,
  },
  railBtnHover: { backgroundColor: colors.surface2 },
  railBtnOn: { backgroundColor: colors.accentDim },
  railBtnOnLabel: { color: colors.accentText },
  /** `.pane` */
  pane: {
    flex: 1,
    minWidth: 0,
    paddingTop: 25,
    paddingHorizontal: 27,
    paddingBottom: 32,
  },
  /** `.panehead` */
  paneHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 20,
    marginBottom: 21,
  },
  paneHeadText: { flex: 1, minWidth: 0 },
  // `max-width:62ch` at 13.5px Instrument Sans measures ~546px.
  paneHeadSub: { marginTop: 6, maxWidth: 546 },
});
