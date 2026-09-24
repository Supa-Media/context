import { ScrollView, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import {
  describePreviewTitle,
  describeShareRow,
  shareUrlFor,
  type NoteShare,
} from "../shares";
import { makeStyles } from "./styles";

/**
 * Who currently has this note.
 *
 * Three states, and the first two are deliberately not the same sentence.
 * `undefined` is "we have not been told yet"; an empty array is "nobody". A
 * dialog that renders loading as "Not shared with anyone" tells the owner their
 * share failed, and the recoverable mistake they make next is sharing it twice.
 */
export function SharedWith({
  shares,
  origin,
  onCopyLink,
  onRevoke,
  onSetPreviewTitle,
}: {
  shares: NoteShare[] | undefined;
  origin: string;
  onCopyLink: (target: { kind: "share"; url: string }) => void;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (share: NoteShare, titleInPreview: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (shares === undefined) {
    return <Text variant="meta">Loading who has access…</Text>;
  }
  if (shares.length === 0) {
    return (
      <Text variant="meta">
        Not shared with anyone yet. Nobody outside this context can open it.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      <Text variant="meta" style={styles.listHead}>
        SHARED WITH
      </Text>
      <ScrollView style={styles.listScroll}>
        {shares.map((share) => (
          <View key={share.shareId} style={styles.share}>
            <View style={styles.shareTop}>
              <Text variant="body" style={styles.recipient} numberOfLines={1}>
                {share.recipient}
              </Text>
              <Button
                label="Copy link"
                onPress={() =>
                  onCopyLink({ kind: "share", url: shareUrlFor(share, origin) })
                }
              />
              <Button
                label="Revoke"
                variant="danger"
                onPress={() => onRevoke(share.shareId)}
              />
            </View>

            {/*
              What this row actually grants, under its name. The list holds
              three things that look alike and one of them needs no account at
              all — "Copy link / Revoke" beside each says nothing about which.
            */}
            <Text variant="meta" style={styles.previewText}>
              {describeShareRow(share.audience)}
            </Text>

            <View style={styles.previewRow}>
              <Text variant="meta" style={styles.previewText}>
                {share.titleInPreview
                  ? describePreviewTitle(share.previewTitle, share.audience)
                  : "The link shows nothing about this note before signing in."}
              </Text>
              <Button
                label={share.titleInPreview ? "Hide name" : "Show name"}
                onPress={() =>
                  onSetPreviewTitle(share, !share.titleInPreview)
                }
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
