import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Dot } from "../../../design/components/Dot";
import { Icon, type IconName } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { layout, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { atName, relativeTime } from "../../format";
import { storagePillLabel } from "../../storage/pill";
import { selectedContext, type ConsoleData } from "../../types";
import { settingsPreview } from "../previews";
import { settingsSectionLabel, type SettingsSectionKey } from "../sections";
import { useWorkspaceIcons } from "../../useWorkspaceIcons";
import { WorkspaceIconPicker, WorkspaceMonogram } from "./WorkspaceIconPicker";

/**
 * Which context this is, whether it is working, and the way to each fact.
 *
 * ## What this replaced
 *
 * Four label/value rows — Name, Kind, You are, Storage — with the values set
 * in mono and right-aligned. It read as a debug dump, and two details are
 * worth naming because they are the difference between a product and a
 * record: `owner` was printed as the enum, lower-cased, straight off the wire;
 * and `Personal workspace` was set in the monospace face, which in this app means
 * "a string you would copy" and a kind is not one. Nothing on the page could
 * be pressed, so somebody who read "R2 · notes-bucket" here and wanted to change it
 * had to go back to the list and find Storage.
 *
 * Now: who this is, whether the bucket is answering, and three facts that are
 * each a way into the section that changes them. The identity carries the
 * role, because being the owner is a fact about *you in this context* rather
 * than a fourth entry in a column of properties.
 *
 * ## The health strip is where "Connected" went
 *
 * It used to be a green pill in the overlay's title bar, which made it the
 * brightest element on the screen and left it saying the least: connected to
 * *what*, and how long ago did anybody check? Here it is the dot, the word,
 * the bucket, and when it was last verified — one line that answers the
 * question people actually open this section with.
 */
export function OverviewPanel({
  data,
  onSelect,
}: {
  data: ConsoleData;
  /**
   * Open another section. Absent on the landing page's console and on the
   * `/settings` fallback, which render every block at once — there the rows
   * are facts rather than destinations, which is what they already were.
   */
  onSelect?: (key: SettingsSectionKey) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  const shared = current?.kind === "shared";
  const [pickingIcon, setPickingIcon] = useState(false);
  /*
    The shared cache, so a photo the rail already fetched is drawn here without
    a second request.
  */
  const iconFor = useWorkspaceIcons();
  const icon = current === null ? undefined : iconFor(current);
  /*
    Owner-only, and absent rather than disabled — the catalogue's own rule. The
    icon shows in every member's rail, so it belongs with the workspace's name
    and storage rather than with the notes an editor may write.
  */
  const canChooseIcon = current !== null && current.role === "owner" && onSelect !== undefined;

  const role =
    current?.role === "owner"
      ? "you're the owner"
      : current?.role === undefined
        ? null
        : `you're ${current.role === "editor" ? "an editor" : "a member"}`;

  return (
    <View>
      <View style={styles.identity} testID="overview-identity">
        {/*
          THIS WAS THE INITIAL OF THE NAME, AND THE NOTE HERE SAID SO: "not an
          avatar. There are no pictures anywhere in this product and inventing
          one here would be the only place a context had a face."

          Reversed deliberately, by the owner, and the reason is the one the
          original could not see: a letter is not an identity. Two contexts
          whose names start alike — `@seyi` and `@supa` — draw the same letter
          in the same square in the switcher, which is the control that exists
          to tell them apart. The face is no longer invented; it is chosen, and
          the letter is what it falls back to.
        */}
        {canChooseIcon ? (
          <Pressable
            role="button"
            accessibilityLabel={
              pickingIcon ? "Close the icon picker" : "Change this workspace’s icon"
            }
            accessibilityState={{ expanded: pickingIcon }}
            onPress={() => setPickingIcon((open) => !open)}
            testID="overview-icon-trigger"
          >
            <WorkspaceMonogram slug={current?.slug ?? "?"} icon={icon} />
          </Pressable>
        ) : (
          <WorkspaceMonogram slug={current?.slug ?? "?"} icon={icon} />
        )}
        <View style={styles.who}>
          <Text variant="noteTitle" numberOfLines={1}>
            {atName(current?.slug ?? "—")}
          </Text>
          <Text variant="rowSub" style={styles.whoSub}>
            {[shared ? "Shared workspace" : "Personal workspace", role]
              .filter((part) => part !== null)
              .join(" · ")}
          </Text>
        </View>
      </View>

      {canChooseIcon && pickingIcon ? (
        <WorkspaceIconPicker
          workspaceId={current.id}
          icon={icon}
          onClose={() => setPickingIcon(false)}
        />
      ) : null}

      <HealthStrip data={data} onSelect={onSelect} />

      {/*
        One word for both kinds, now that both kinds are workspaces. The
        heading used to fork — "This workspace" / "This brain" — and the fork
        was the vocabulary rather than anything about the facts under it.
      */}
      <Text variant="listGroup" style={styles.heading}>
        This workspace
      </Text>
      <View style={styles.card}>
        {FACTS.map((key, index) => {
          const value = settingsPreview(key, data);
          return (
            <View key={key}>
              {index === 0 ? null : <View style={styles.divider} />}
              <Fact
                icon={FACT_ICONS[key]}
                label={settingsSectionLabel(key)}
                value={value}
                onPress={onSelect === undefined ? undefined : () => onSelect(key)}
                testID={`overview-fact-${key}`}
              />
            </View>
          );
        })}
      </View>

      {/* Deliberately not a fourth fact. `settingsPreview` cannot answer for
          the plan without hoisting Premium's own subscription onto every
          console load, and a row that navigates and says nothing is the list
          this section was supposed to be an answer to. */}

      {/*
        "Delete this workspace" used to be a signpost here, pointing at the
        Advanced section. Advanced is a block on this same page now, with the
        deletion card in it and the same sentence about what survives, so the
        signpost would be a press that goes nowhere and a second copy of the
        copy it was pointing at.
      */}
    </View>
  );
}

/**
 * The three facts that say what a context *is*.
 *
 * Storage and sharing: where the notes are, and who can see them. Those were
 * three facts — storage, privacy, membership — until privacy and membership
 * became two blocks of one section, and a fact row per block would be this
 * panel deciding the other screen's shape for it. Search and the capture
 * sources are settings *about* a context rather than descriptions of one, and
 * Premium is a question about the account paying for it.
 */
const FACTS: readonly SettingsSectionKey[] = ["storage", "sharing"];

const FACT_ICONS: Record<string, IconName> = {
  storage: "drive",
  sharing: "people",
};

function HealthStrip({
  data,
  onSelect,
}: {
  data: ConsoleData;
  onSelect?: (key: SettingsSectionKey) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  /*
    Three absences and two failures, kept apart. `undefined` is a binding that
    has not answered — the distinction `ConsoleData.storage` spends a
    paragraph on — and saying "no bucket connected" for it is the defect that
    paragraph exists to record.

    Written out per state rather than keyed off the tone. A `styles[\`strip$
    {tone}\`]` lookup is two characters shorter and is how a palette entry
    goes missing without anything failing to compile.
  */
  const state = describeBinding(data);
  const strip = {
    ok: styles.stripOk,
    warn: styles.stripWarn,
    crit: styles.stripCrit,
    neutral: styles.stripNeutral,
  }[state.tone];
  const stripText = {
    ok: styles.stripOkText,
    warn: styles.stripWarnText,
    crit: styles.stripCritText,
    neutral: styles.stripNeutralText,
  }[state.tone];

  return (
    <View style={[styles.strip, strip]} testID="overview-health">
      <Dot tone={state.tone} size={8} />
      <View style={styles.stripText}>
        <Text variant="rowTitle" style={stripText}>
          {state.headline}
        </Text>
        {state.detail === null ? null : (
          <Text variant="rowSub" style={styles.stripDetail}>
            {state.detail}
          </Text>
        )}
      </View>
      {state.action === null || onSelect === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${state.action} storage`}
          onPress={() => onSelect("storage")}
          style={styles.stripAction}
          testID="overview-health-action"
        >
          <Text variant="mini" style={styles.stripActionText}>
            {state.action}
          </Text>
          <Icon name="chevronRight" size={12} color={colors.accent} />
        </Pressable>
      )}
    </View>
  );
}

type BindingTone = "ok" | "warn" | "crit" | "neutral";

interface BindingState {
  tone: BindingTone;
  headline: string;
  detail: string | null;
  /** The word on the way into Storage, or `null` where there is nothing to do. */
  action: string | null;
}

function describeBinding(data: ConsoleData): BindingState {
  const storage = data.storage;
  if (storage === undefined) {
    return { tone: "neutral", headline: "Checking…", detail: null, action: null };
  }
  if (storage === null) {
    return {
      tone: "warn",
      headline: "No bucket connected",
      detail: "Your notes have nowhere to live yet.",
      action: "Connect",
    };
  }
  const detail = verifiedLine(storagePillLabel(storage), storage.lastVerifiedAt);
  if (storage.connected) {
    return { tone: "ok", headline: "Connected", detail, action: "Manage" };
  }
  return storage.status === "error"
    ? { tone: "crit", headline: "Not working", detail, action: "Fix" }
    : { tone: "warn", headline: "Not verified", detail, action: "Check" };
}

/**
 * The bucket, and when anybody last checked it was there.
 *
 * The time is the half people are actually asking for: "connected" is a claim
 * about a probe that may have run last week. Omitted where there has never
 * been one rather than guessed at.
 */
function verifiedLine(label: string | null, lastVerifiedAt: number | undefined): string | null {
  const when = lastVerifiedAt === undefined ? null : `checked ${relativeTime(lastVerifiedAt, Date.now())}`;
  return [label, when].filter((part) => part !== null).join(" — ") || null;
}

function Fact({
  icon,
  label,
  value,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  value: string | null;
  onPress?: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const inner = (
    <>
      <Icon name={icon} size={19} color={colors.muted} />
      <Text variant="rowTitle">{label}</Text>
      <View style={styles.grow} />
      {value === null ? null : (
        <Text variant="rowSub" numberOfLines={1} style={styles.factValue}>
          {value}
        </Text>
      )}
      {onPress === undefined ? null : (
        <Icon name="chevronRight" size={13} color={colors.muted} />
      )}
    </>
  );
  if (onPress === undefined) {
    return (
      <View style={styles.fact} testID={testID}>
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.fact}
      testID={testID}
    >
      {inner}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    identity: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    who: { flex: 1, minWidth: 0 },
    whoSub: { marginTop: 1 },
    strip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      marginTop: space.x4,
      padding: space.x3,
      borderRadius: radii.card,
      borderWidth: 1,
      maxWidth: 560,
    },
    stripOk: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
    stripWarn: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
    /*
      `crit`, not a second copy of `warn`. "Not working" and "Not verified"
      are a broken bucket and an unprobed one, and drawing them in the same
      wash leaves the difference to a hue on four words of text.
    */
    stripCrit: { backgroundColor: colors.critWash, borderColor: colors.critBorder },
    stripNeutral: { backgroundColor: colors.surface2, borderColor: colors.line },
    stripOkText: { color: colors.okText },
    stripWarnText: { color: colors.warnText },
    stripCritText: { color: colors.critText },
    stripNeutralText: { color: colors.text2 },
    stripText: { flex: 1, minWidth: 0 },
    stripDetail: { marginTop: 2 },
    stripAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 1,
      minHeight: layout.minTouchTarget,
      paddingLeft: space.x2,
    },
    stripActionText: { color: colors.accent },
    heading: { marginTop: space.x6, marginBottom: space.x2 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      overflow: "hidden",
      maxWidth: 560,
    },
    divider: { height: 1, backgroundColor: colors.line, marginLeft: 47 },
    fact: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: layout.minTouchTarget,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
    },
    factValue: { flexShrink: 1, textAlign: "right" },
    grow: { flexGrow: 1, minWidth: space.x2 },
    /*
      Its own outline rather than a fourth row in the card above. The facts are
      a set of like things and this is not one of them — a destructive
      destination sitting inside that border, one divider below "People", is
      exactly the row somebody presses on the way to somewhere else.

      And the *same* outline as that card, not a red wash. The title carries
      the warning colour and nothing else does, which is the convention every
      destructive control in this app already follows (`DeleteAccountCard` and
      `DeleteWorkspaceCard` are both a plain card with one danger-coloured
      control in them). A permanently tinted box would make the loudest thing
      on this page a control that is merely *available* — and it would sit
      inches under a health strip that uses those exact washes to mean a bucket
      is broken, which is a real state this is not.
    */
    wayOut: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      marginTop: space.x5,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
      minHeight: layout.minTouchTarget,
      maxWidth: 560,
    },
    wayOutText: { flex: 1, minWidth: 0 },
    wayOutTitle: { color: colors.critText },
    wayOutSub: { marginTop: 2 },
  });
