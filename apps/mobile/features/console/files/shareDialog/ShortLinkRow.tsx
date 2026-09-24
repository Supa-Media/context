import { useState } from "react";
import { TextInput, View } from "react-native";
import { Button } from "../../../design/components/Button";
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
}: {
  handle: string;
  share: NoteShare;
  onSetSlug: (shareId: string, slug: string | null) => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

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
        if (ok) setTyped("");
      })
      .finally(() => setBusy(false));
  };

  const release = () => {
    if (busy) return;
    setBusy(true);
    void onSetSlug(share.shareId, null).finally(() => setBusy(false));
  };

  return (
    <View style={styles.section} testID="share-short-link">
      <View style={styles.linkRow}>
        <View style={styles.linkMain}>
          <Text variant="rowTitle">Short link</Text>
          <Text variant="meta" style={styles.linkNote}>
            {claimed === null
              ? "A name you choose, under your handle."
              : "This link also opens at the name you chose."}
          </Text>
        </View>
      </View>

      {claimed === null ? (
        <View style={styles.row}>
          <View style={styles.shortLinkField}>
            <Text variant="meta" style={styles.shortLinkPrefix}>
              {`context.lc/@${handle}/`}
            </Text>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.shortLinkInput}
              placeholder="intake"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Short link name"
              onSubmitEditing={claim}
              testID="share-short-link-name"
            />
          </View>
          <Button
            label="Claim"
            variant="white"
            disabled={!wellFormed || busy}
            onPress={claim}
            testID="share-short-link-claim"
          />
        </View>
      ) : (
        <View style={styles.linkRow}>
          <Text variant="meta" style={styles.shortLinkClaimed} selectable>
            {`context.lc/@${handle}/${claimed}`}
          </Text>
          <Button
            label="Release"
            disabled={busy}
            onPress={release}
            testID="share-short-link-release"
          />
        </View>
      )}

      {share.audience !== "anyone" ? null : (
        <Text variant="meta" style={styles.linkNote} testID="share-short-link-warning">
          A short link is memorable, which means guessable. Anyone who types it
          gets what this link gives — treat it as published. The long link stays
          unguessable if you would rather.
        </Text>
      )}
    </View>
  );
}
