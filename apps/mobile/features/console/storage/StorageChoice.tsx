import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { ConnectForm } from "./ConnectForm";
import { DROPBOX_REDIRECT_ORIGINS } from "./dropbox";
import { useDropboxStart } from "./useDropboxStart";
import type { ConnectFormValues } from "./connect";

/**
 * Two square cards, and nothing else until one is chosen.
 *
 * This replaces a screen that showed the Dropbox pitch, a paragraph of
 * trade-off prose, and the whole bucket form at once. Seyi's verdict on it:
 * too robust — "just two options, simple square cards next to each other".
 * The details belong behind the click, not in front of it.
 *
 * **The bucket is first.** It is the path we recommend — storage that answers
 * to nobody but its owner, revocable at a provider they pay themselves,
 * syncable to Obsidian where it already lives. Dropbox is the tier for
 * somebody who will never make a bucket, and second position is part of
 * saying so.
 *
 * **Pressing Dropbox goes, it does not reveal.** There is nothing to ask —
 * the app is folder-scoped, so there is no folder question and no credential
 * to paste — and a card that expanded into one more button would be a step
 * that exists only to be clicked through. The one case with something to show
 * is an origin Dropbox will not redirect back to (a native build, an
 * unregistered host); pressing there explains instead of leaving for an error
 * page. The second-context folder question this screen used to carry is gone
 * with the prose: `rootPrefix` still exists end to end, and the rare person
 * who needs it is not served by every first-run seeing the question.
 */
export function StorageChoice({
  workspaceId,
  connect,
  onCancel,
  dropboxNote,
  dropboxResumeTo,
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
}: {
  dropboxReady: boolean;
  redirectUri: string | null;
  dropboxState: import("./dropbox").DropboxStartState;
  startDropbox: () => void;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  onCancel?: () => void;
  dropboxNote?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [bucketOpen, setBucketOpen] = useState(false);
  const [dropboxBlocked, setDropboxBlocked] = useState(false);

  const starting = dropboxState.kind === "starting";

  return (
    <View style={styles.stack}>
      <View style={styles.cards}>
        <ChoiceCard
          testID="choose-bucket"
          title="Connect an S3 bucket"
          sub="Storage you own outright. Works with R2, S3, B2 — and syncs to Obsidian."
          badge="Recommended"
          selected={bucketOpen}
          onPress={() => setBucketOpen((open) => !open)}
        />
        <ChoiceCard
          testID="choose-dropbox"
          title="Connect Dropbox"
          sub="One click. Context gets its own folder — the rest stays invisible to us."
          selected={false}
          busy={starting}
          disabled={!dropboxReady || starting}
          onPress={() => {
            if (redirectUri === null) {
              // Explain rather than leave for Dropbox's own error page.
              setDropboxBlocked(true);
              return;
            }
            startDropbox();
          }}
        />
      </View>

      {dropboxBlocked && redirectUri === null ? (
        <Text variant="foot" role="status" style={styles.note} testID="dropbox-unavailable">
          Connecting Dropbox happens in a browser at{" "}
          {DROPBOX_REDIRECT_ORIGINS.join(" or ")} — open one of those and this card works.
          A bucket connects from anywhere, including here.
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
          next={[dropboxState.failure.next, dropboxState.failure.detail]
            .filter(Boolean)
            .join(" ")}
        />
      ) : null}

      {bucketOpen ? <ConnectForm connect={connect} onCancel={onCancel} /> : null}
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
  selected,
  busy,
  disabled,
  onPress,
  testID,
}: {
  title: string;
  sub: string;
  badge?: string;
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
      accessibilityState={{ selected, disabled: Boolean(disabled), busy: Boolean(busy) }}
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
        <Text variant="foot" style={styles.badge}>
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

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  choiceSelected: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },
  choicePressed: { backgroundColor: colors.surface3 },
  choiceDisabled: { opacity: 0.55 },
  badge: { color: colors.okText },
  sub: { lineHeight: leading(13, 1.55) },
  busy: { position: "absolute", top: 14, right: 14 },
  note: { lineHeight: leading(12.5, 1.7) },
});
