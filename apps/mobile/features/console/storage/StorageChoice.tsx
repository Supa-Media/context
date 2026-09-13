import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { EARLY_TESTER_PRICE_SHORT } from "../settings/panels/premium";
import { ConnectForm } from "./ConnectForm";
import { DROPBOX_REDIRECT_ORIGINS } from "./dropbox";
import { useDropboxStart } from "./useDropboxStart";
import type { ConnectFormValues } from "./connect";

/**
 * Storage starts with the decision a person is actually making: run it
 * themselves or let Context run it. Provider details stay behind the first
 * path so S3 and Dropbox do not look like separate product tiers.
 */
export function StorageChoice({
  workspaceId,
  connect,
  onCancel,
  dropboxNote,
  dropboxResumeTo,
  managed,
}: {
  /** The context being connected. `null` disables the Dropbox card only. */
  workspaceId: string | null;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Present when this is replacing a binding rather than making the first one. */
  onCancel?: () => void;
  /** One line about what leaving for Dropbox does to the screen this is on. */
  dropboxNote?: string;
  /** Set from first-run, so the callback can hand the person back to it. */
  dropboxResumeTo?: "onboarding";
  /** Absent unless billing says this deployment can provision the storage. */
  managed?: { price: string; onChoose: () => void };
}) {
  const dropbox = useDropboxStart(workspaceId, { resumeTo: dropboxResumeTo });
  return (
    <StorageChoiceBody
      dropboxReady={workspaceId !== null}
      redirectUri={dropbox.redirectUri}
      dropboxState={dropbox.state}
      startDropbox={dropbox.start}
      connect={connect}
      onCancel={onCancel}
      dropboxNote={dropboxNote}
      managed={managed}
    />
  );
}

/**
 * The screen itself, hooks already resolved — what the suite drives directly,
 * exactly as `DropboxCallbackBody` is.
 */
export function StorageChoiceBody({
  dropboxReady,
  redirectUri,
  dropboxState,
  startDropbox,
  connect,
  onCancel,
  dropboxNote,
  managed,
}: {
  dropboxReady: boolean;
  redirectUri: string | null;
  dropboxState: import("./dropbox").DropboxStartState;
  startDropbox: () => void;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  onCancel?: () => void;
  dropboxNote?: string;
  managed?: { price: string; onChoose: () => void };
}) {
  const styles = useThemedStyles(makeStyles);
  const [ownOpen, setOwnOpen] = useState(false);
  const [bucketOpen, setBucketOpen] = useState(false);
  const [dropboxBlocked, setDropboxBlocked] = useState(false);

  const starting = dropboxState.kind === "starting";

  return (
    <View style={styles.stack}>
      <View style={styles.cards}>
        <ChoiceCard
          testID="choose-own-storage"
          title="Bring your own storage"
          sub="Use storage you control through an S3-compatible provider or Dropbox."
          selected={ownOpen}
          onPress={() => {
            setOwnOpen((open) => !open);
            setBucketOpen(false);
          }}
        />
        {managed === undefined ? null : (
          /*
            The badge is the number and the sub says what kind of number it is.
            Splitting it that way keeps the badge a badge — it is a pill beside
            a title, and "$5 a month — early tester price, held for as long as
            you keep it" is a paragraph — while still putting the framing on
            the card somebody chooses from rather than only on the confirm
            screen behind it.
          */
          <ChoiceCard
            testID="choose-managed"
            title="Context-managed Premium storage"
            sub={`Get 50 GB for this context. Context sets it up and keeps it running. ${EARLY_TESTER_PRICE_SHORT}`}
            badge={managed.price}
            badgeTone="neutral"
            selected={false}
            onPress={managed.onChoose}
          />
        )}
      </View>

      {ownOpen ? (
        <View style={styles.providerSection} testID="own-storage-providers">
          <Text variant="eyebrow">Choose a provider</Text>
          <View style={styles.cards}>
            <ChoiceCard
              testID="choose-bucket"
              title="S3-compatible storage"
              sub="Connect R2, Amazon S3, Backblaze B2, Wasabi, or another compatible provider."
              selected={bucketOpen}
              onPress={() => setBucketOpen((open) => !open)}
            />
            <ChoiceCard
              testID="choose-dropbox"
              title="Dropbox"
              sub="Connect with one click. Context gets its own folder in Dropbox."
              selected={false}
              busy={starting}
              disabled={!dropboxReady || starting}
              onPress={() => {
                if (redirectUri === null) {
                  setDropboxBlocked(true);
                  return;
                }
                startDropbox();
              }}
            />
          </View>
        </View>
      ) : null}

      {dropboxBlocked && redirectUri === null ? (
        <Text variant="foot" role="status" style={styles.note} testID="dropbox-unavailable">
          Connecting Dropbox happens in a browser at {DROPBOX_REDIRECT_ORIGINS.join(" or ")}. Open one of those and this
          card works. A bucket connects from anywhere, including here.
        </Text>
      ) : null}
      {dropboxNote && !dropboxBlocked ? (
        <Text variant="foot" style={styles.note}>
          {dropboxNote}
        </Text>
      ) : null}
      {dropboxState.kind === "failed" ? (
        <FormError
          headline={dropboxState.failure.headline}
          next={[dropboxState.failure.next, dropboxState.failure.detail].filter(Boolean).join(" ")}
        />
      ) : null}

      {ownOpen && bucketOpen ? <ConnectForm connect={connect} onCancel={onCancel} /> : null}
    </View>
  );
}

/**
 * One square-ish option. A `Pressable` rather than a `Card`, because the whole
 * face is the control — and `minWidth` + `flexWrap` on the row above is what
 * stacks them on a phone without a width branch (`useWindowDimensions` is 0 in
 * jsdom, so a width branch would also make every test silently take the phone
 * path).
 */
function ChoiceCard({
  title,
  sub,
  badge,
  badgeTone = "ok",
  selected,
  busy,
  disabled,
  onPress,
  testID,
}: {
  title: string;
  sub: string;
  badge?: string;
  /** `ok` for a positive status, `neutral` for a price. */
  badgeTone?: "ok" | "neutral";
  selected: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{
        selected,
        disabled: Boolean(disabled),
        busy: Boolean(busy),
      }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
        disabled && styles.choiceDisabled,
      ]}
    >
      {badge ? (
        <Text variant="foot" style={badgeTone === "ok" ? styles.badge : styles.badgePrice}>
          {badge}
        </Text>
      ) : null}
      <Text variant="rowTitle">{title}</Text>
      <Text variant="rowSub" style={styles.sub}>
        {sub}
      </Text>
      {busy ? <ActivityIndicator size="small" color={colors.text2} style={styles.busy} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: 14 },
    cards: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    choice: {
      flexGrow: 1,
      flexBasis: 220,
      minHeight: 132,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 16,
      paddingHorizontal: 16,
    },
    providerSection: { gap: 10 },
    choiceSelected: {
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
    },
    choicePressed: { backgroundColor: colors.surface3 },
    choiceDisabled: { opacity: 0.55 },
    badge: { color: colors.okText },
    badgePrice: { color: colors.text2 },
    sub: { lineHeight: leading(13, 1.55) },
    busy: { position: "absolute", top: 14, right: 14 },
    note: { lineHeight: leading(12.5, 1.7) },
  });
