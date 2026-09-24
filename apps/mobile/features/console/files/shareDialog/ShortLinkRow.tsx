import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { NoteShare } from "../shares";
import { makeStyles } from "./styles";

/**
 * The short link: one memorable address for a link that already exists.
 *
 * ## The warning is not decoration
 *
 * Everything else in this dialog hands out an unguessable URL. This hands out
 * a word, and for a link anyone can open, being able to type the word *is* the
 * access. Somebody claiming `intake` is publishing that note to whoever guesses
 * `intake` — which is what they want, and which they have to be told in the
 * same breath rather than in a help page. So the sentence sits between the
 * field and the button, in the one place it cannot be scrolled past.
 *
 * It is drawn only for an `anyone` link. On a workspace link the reader is
 * still authorised by membership on every request, so a guessed name opens
 * nothing, and a warning there would be the dialog crying wolf — which is the
 * habit that costs people the warning that mattered.
 *
 * ## The field refuses locally only for what it can refuse honestly
 *
 * Shape is checked here so the obvious typo does not need a round trip, and
 * everything else — reserved, taken, a name this product writes — comes back
 * from the server with its own sentence. A second copy of those lists here
 * would be a second place for them to disagree, and the one that drifts is the
 * one nobody runs.
 */
export function ShortLinkRow({
  handle,
  share,
  onSetSlug,
  compact,
}: {
  handle: string;
  compact: boolean;
  share: NoteShare;
  onSetSlug: (shareId: string, slug: string | null) => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  // Closed until asked for: most links never get a name, and an always-open
  // field, a disabled button and a warning made every link taller for it.
  const [editing, setEditing] = useState(false);

  const claimed = share.slug ?? null;
  const candidate = typed.trim().toLowerCase();
  // The router's and the control plane's shape, restated for the field alone.
  // Three copies of a rule are held by `shortLinkSlug.fixtures.json`; this
  // fourth is a keystroke-level courtesy and refuses nothing the server does
  // not refuse again.
  const wellFormed = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(candidate);

  const claim = () => {
    if (!wellFormed || busy) return;
    setBusy(true);
    void onSetSlug(share.shareId, candidate)
      .then((ok) => {
        // Cleared on success, kept on a refusal: the notice explaining why is
        // behind this modal, and retyping a name somebody has just had
        // rejected is the worst moment to make them start over.
        if (ok) {
          setTyped("");
          setEditing(false);
        }
      })
      .finally(() => setBusy(false));
  };

  const release = () => {
    if (busy) return;
    setBusy(true);
    void onSetSlug(share.shareId, null).finally(() => setBusy(false));
  };

  const nameStyle = [styles.name, compact && styles.nameCompact];
  const metaStyle = [styles.meta, compact && styles.metaCompact];

  return (
    <View
      style={[styles.subRow, styles.subRowLast, { alignItems: "flex-start" }]}
      testID="share-short-link"
    >
      <Icon name="link" size={16} color={colors.muted} style={{ marginTop: 3 }} />
      <View style={styles.rowMain}>
        <Text style={nameStyle}>Short link</Text>
        {claimed !== null ? (
          <Text variant="meta" style={[metaStyle, { color: colors.text2 }]} selectable>
            {`context.lc/@${handle}/${claimed}`}
          </Text>
        ) : !editing ? (
          <Text variant="meta" style={metaStyle}>
            None yet
          </Text>
        ) : (
          <>
            {/* Wraps the Claim button under the field on a phone rather than breaking the prefix. */}
            <View style={[styles.row, { minHeight: 0, gap: 8, marginTop: 6, flexWrap: compact ? "wrap" : "nowrap" }]}>
              <View style={[styles.shortLinkField, { minWidth: 220 }]}>
                <Text variant="meta" style={[styles.meta, { flexShrink: 0 }]} numberOfLines={1}>
                  {`context.lc/@${handle}/`}
                </Text>
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  style={styles.shortLinkInput}
                  placeholder="intake"
                  placeholderTextColor={colors.muted}
                  accessibilityLabel="Short link name"
                  onSubmitEditing={claim}
                  testID="share-short-link-name"
                />
              </View>
              <Pressable
                accessibilityLabel="Claim"
                aria-disabled={!wellFormed || busy}
                disabled={!wellFormed || busy}
                testID="share-short-link-claim"
                style={[styles.footButton, styles.smallButton, (!wellFormed || busy) && { opacity: 0.45 }]}
                onPress={claim}
              >
                <Text style={styles.footLabel}>Claim</Text>
              </Pressable>
            </View>
            {share.audience !== "anyone" ? null : (
              <Text variant="meta" style={[metaStyle, { marginTop: 6 }]} testID="share-short-link-warning">
                Short names are guessable. Anyone who types it gets what this link gives.
              </Text>
            )}
          </>
        )}
      </View>
      {claimed !== null ? (
        <Pressable
          accessibilityLabel="Remove short link"
          disabled={busy}
          testID="share-short-link-release"
          onPress={release}
          style={{ marginTop: 2 }}
        >
          <Text variant="meta" style={styles.link}>
            Remove
          </Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityLabel={editing ? "Cancel short link" : "Add a short link"}
          testID="share-short-link-add"
          onPress={() => {
            setTyped("");
            setEditing((open) => !open);
          }}
          style={{ marginTop: 2 }}
        >
          <Text variant="meta" style={styles.link}>
            {editing ? "Cancel" : "Add"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
