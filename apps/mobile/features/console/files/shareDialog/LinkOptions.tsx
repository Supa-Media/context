import { View } from "react-native";
import { useThemedStyles } from "../../../design/theme";
import type { AudienceContext } from "../../privacy/audience";
import type { NoteShare } from "../shares";
import { CollectRow } from "./CollectRow";
import type { ShareDialogProps } from "./props";
import { ShortLinkRow } from "./ShortLinkRow";
import { makeStyles } from "./styles";

/**
 * What a live link can also do: take form answers, and answer to a short name.
 *
 * Drawn under the General access line it belongs to, indented to that line's
 * text, and only when there is a link to modify. Each row is absent when its
 * caller cannot do it — the landing page's demo has no server behind it — so
 * the block is absent entirely rather than an empty frame.
 */
export function LinkOptions({
  entryKind,
  context,
  compact,
  openLink,
  namedLink,
  indented,
  onSetCollecting,
  onSetSlug,
}: {
  entryKind: "file" | "folder";
  context: AudienceContext;
  compact: boolean;
  openLink: NoteShare | undefined;
  namedLink: NoteShare | undefined;
  /** Under the General access line, rather than standing alone. */
  indented: boolean;
  onSetCollecting: ShareDialogProps["onSetCollecting"];
  onSetSlug: ShareDialogProps["onSetSlug"];
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    A workspace link already has readers with accounts, and a folder link
    would publish every form beneath it on one decision; the server refuses
    both, so the switch is only drawn for an open link over a note.
  */
  const collect =
    openLink !== undefined && entryKind === "file" && onSetCollecting !== undefined;
  const short = namedLink !== undefined && context.slug !== null && onSetSlug !== undefined;
  if (!collect && !short) return null;

  return (
    <View
      style={[indented && (compact ? styles.indentCompact : styles.indent), styles.subList]}
      testID="share-link-options"
    >
      {!collect ? null : (
        <CollectRow
          share={openLink!}
          onSetCollecting={onSetCollecting!}
          compact={compact}
          last={!short}
        />
      )}
      {!short ? null : (
        <ShortLinkRow handle={context.slug!} share={namedLink!} onSetSlug={onSetSlug!} compact={compact} />
      )}
    </View>
  );
}
