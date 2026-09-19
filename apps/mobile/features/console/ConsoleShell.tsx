import type { ReactNode } from "react";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { PressRow, WindowDots } from "../design/components/Button";
import { Dot } from "../design/components/Dot";
import { Pill } from "../design/components/Pill";
import { Text } from "../design/components/Text";
import { layout, pointerType as t, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { EditorState } from "./files/editor";
import { saveChip } from "./files/status";
import { atName } from "./format";
import { APP_SECTIONS, selectContextRoute, type ConsoleRoute } from "./nav";
import { railGroup } from "./rail";
import { selectedContext, type ConsoleData } from "./types";
import { tierChipLabel } from "./visibility";
import type { Presence } from "./presence/usePresence";

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
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const narrow = width < layout.narrowBreakpoint;
  const current = selectedContext(data);
  const insideContext = route.kind === "context";
  const group = railGroup({ contexts: data.contexts, claimable: false });

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
              <Text variant="wsSwitch">Your context</Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {`${data.contexts.length} reachable`}
              </Text>
            </>
          )}
        </View>
        <View
          style={styles.avatar}
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
            One list, personal workspace pinned first — the same shape, from
            the same function, as the real console's rail. See `rail.ts`. The
            landing page never offers the claim or the new-workspace entry: a
            picture has nowhere to send anybody.
          */}
          <View style={[styles.railGroup, narrow && styles.railGroupNarrow]}>
            <Text variant="railHead" style={styles.railHead}>
              {group.heading}
            </Text>
            {data.contexts.length === 0 && !data.loading ? (
              <Text variant="rowSub" style={styles.railEmpty}>
                Nothing here yet
              </Text>
            ) : null}
            {group.contexts.map((context) => (
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
  const styles = useThemedStyles(makeStyles);
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
  leading,
  trailing,
}: {
  title: string;
  description?: string;
  /**
   * The way out, for a pane that needs one drawn.
   *
   * The app-level panes — Search, Map, Connections — are full-screen on a
   * phone with no rail and no bottom toolbar behind them (`frame.ts`, and the
   * `browsing` gate in the console layout), so a pane that does not draw an
   * exit does not have one. A context's own panes leave it absent: the toolbar
   * and the tree are their navigation.
   */
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const narrow = width > 0 && width < layout.narrowBreakpoint;

  return (
    <View style={styles.paneHead}>
      {leading}
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
 * Whether what you have typed is in the bucket yet, in the top bar.
 *
 * **This is where the Save button went.** The console autosaves a couple of
 * seconds after typing stops (`autosave.ts`), and while that write was pending
 * the editor drew "Discard changes" and "Save" across the foot of the note —
 * two controls over somebody's own text, in the middle of the screen, for the
 * whole time they were writing. They were not there to be pressed: ⌘S and the
 * autosave timer both do what Save does, and the row appeared in `dirty`,
 * which is the state every keystroke produces. What a person actually wants
 * during that second or two is *reassurance*, and reassurance is a chip, not a
 * button.
 *
 * So the states split by whether a person has to do something:
 *
 *  - **Nothing owed** — typing, saving, saved, a cached body, a queued draft
 *    draining on its own — this chip, and nothing over the note.
 *  - **A decision owed** — a save that failed, a conflict — `NoteEditor` still
 *    draws the row, because `editor.ts` is explicit that the manual route has
 *    to stay reachable exactly where autosave refuses.
 *
 * Beside the bucket chip rather than anywhere else, because the two answer one
 * question between them: where the note lives, and whether it is there yet.
 * `saveChip` supplies the words and the tone — the same arms, the same detail
 * strings and the same tests as when the status strip carried them.
 *
 * **Leading the trailing group**, which is a layout rule rather than a
 * preference: this is the only chip in the bar whose text changes while
 * somebody types, and in a row aligned to the trailing edge the leading item is
 * the one that can grow without pushing its neighbours about.
 */
export function SaveChip({ editor }: { editor: EditorState }) {
  const chip = saveChip({ editor, now: Date.now() });
  if (chip === null) return null;

  /*
    A dot for the two tones that want the eye, and none for the rest. Every
    state here has a tone, so a dot on all of them would be a row of lights —
    `status.ts` makes the same argument about the strip's pip. "Saving…" is the
    ordinary case and gets the ordinary chip; "Queued" and "Not saved" are
    states somebody is being asked to notice.
  */
  const tone = chip.tone === "quiet" ? "neutral" : chip.tone;
  const loud = chip.tone === "warn" || chip.tone === "crit";

  /*
    The sentence behind the word, the same way `StatusBarSegment` carries it:
    RN-Web forwards `title` to the DOM node, and the accessible name says both
    so a screen reader is not left with "Queued".
  */
  const tip =
    Platform.OS === "web" && chip.detail ? ({ title: chip.detail } as object) : null;

  return (
    <View
      accessible
      accessibilityLabel={chip.detail ? `${chip.text}. ${chip.detail}` : chip.text}
      testID="save-chip"
      {...tip}
    >
      <Pill tone={tone} leading={loud ? <Dot tone={tone} /> : undefined}>
        {chip.text}
      </Pill>
    </View>
  );
}

/**
 * Who else has this note open, beside the chip that says whether it is saved.
 *
 * Beside `SaveChip` for that chip's own reason: the two answer one question
 * between them. Where the note lives and whether the last keystroke is there,
 * and then — the thing you want to know a moment before you start typing over
 * somebody — whether anybody else is in it.
 *
 * **It renders nothing when nobody else is here**, which is almost always, and
 * nothing at all when presence is unavailable: a self-host without the binding,
 * a note opened offline, a gateway that refused. A component that can return
 * `null` is what lets the bar mount it unconditionally rather than repeating
 * that rule at the call site. An absent capability is reported, never faked,
 * and here reporting it is drawing the bar that existed before this feature.
 *
 * The avatars are initials on the colour the room gave each person, the same
 * colour their caret is drawn in, so the row and the text agree without anybody
 * having to match a name to a hue. Past four they stop being faces and become a
 * count — the rest is in the label beside them.
 */
export function PresenceChip({ presence }: { presence: Presence }) {
  const styles = useThemedStyles(presenceStyles);
  if (presence.phase === "unavailable" || presence.phase === "idle") return null;
  if (presence.summary === "") return null;

  const shown = presence.members.slice(0, 4);

  return (
    <View
      accessible
      accessibilityLabel={
        presence.members.length === 0
          ? presence.summary
          : `${presence.summary}: ${presence.members.map((one) => one.name).join(", ")}`
      }
      testID="presence-chip"
      style={styles.row}
    >
      {shown.map((member, index) => (
        <View
          key={member.id}
          style={[
            styles.avatar,
            { backgroundColor: member.color },
            index === 0 ? null : styles.overlap,
          ]}
        >
          <Text variant="meta" style={styles.initials}>
            {initialsFor(member.name)}
          </Text>
        </View>
      ))}
      <Pill tone={presence.phase === "reconnecting" ? "warn" : "neutral"}>{presence.summary}</Pill>
    </View>
  );
}

/**
 * Two characters from a handle.
 *
 * The handle is `@sayo`, so the `@` is dropped rather than shown: a row of
 * avatars all reading "@" tells you how many people are here and nothing else,
 * which the count beside them already said.
 */
function initialsFor(name: string): string {
  const bare = name.startsWith("@") ? name.slice(1) : name;
  return bare.slice(0, 2).toLowerCase() || "?";
}

const presenceStyles = (c: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 6 },
    avatar: {
      width: 22,
      height: 22,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
    },
    // Tightened into a stack, each lifted off the one behind it by a ring in
    // the bar's own colour so the overlap reads as depth rather than a smudge.
    overlap: { marginLeft: -7, borderWidth: 2, borderColor: c.chromeSurface },
    initials: { color: c.ink, fontWeight: "700" },
  });

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

const makeStyles = (colors: Colors) => StyleSheet.create({
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
    /*
      The one mark that says "this is yours", so it wears the one hue the
      interface spends on itself. It was a `#3B82F6` → `#8B5CF6` gradient over
      a flat `#5F6EF6` fallback — blue-500 to violet-500, the two framework
      defaults the palette retired, surviving in a gradient string where
      nothing was looking for them. Flat, because a gradient here is decoration
      spending the budget that `sharedWash` needs to mean something.
    */
    backgroundColor: colors.accent,
  },
  avatarInitial: {
    fontSize: t.label,
    fontWeight: "700",
    color: colors.ink,
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
