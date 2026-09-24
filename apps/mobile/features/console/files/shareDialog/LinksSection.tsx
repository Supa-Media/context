import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import type { AudienceContext } from "../../privacy/audience";
import {
  describeLinkReach,
  describeOpenLink,
  describeTeamLink,
  type NoteShare,
} from "../shares";
import { CollectRow } from "./CollectRow";
import type { CopyTarget, ShareDialogProps } from "./props";
import { ShortLinkRow } from "./ShortLinkRow";
import { makeStyles } from "./styles";

/**
 * LINKS: the workspace link, the unlisted link when there is one, its
 * answer-taking switch and its short name. The state is `ShareDialog`'s; this
 * draws it.
 */
export function LinksSection({
  path,
  entryKind,
  context,
  problem,
  openLink,
  namedLink,
  copyAndClose,
  onRevoke,
  onSetCollecting,
  onSetSlug,
}: {
  path: string;
  entryKind: "file" | "folder";
  context: AudienceContext;
  problem: string | null;
  openLink: NoteShare | undefined;
  namedLink: NoteShare | undefined;
  copyAndClose: (target: CopyTarget) => void;
  onRevoke: ShareDialogProps["onRevoke"];
  onSetCollecting: ShareDialogProps["onSetCollecting"];
  onSetSlug: ShareDialogProps["onSetSlug"];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {/*
        One section for the two links, not two sections with a paragraph
        each.

        They are different audiences and that difference still has to be
        said — a `/console/@…` link shows nothing to somebody without
        access, which is the bug the second one was added for — but it is
        one line beside each button rather than a block above it. Three
        eyebrow headings for three kinds of link was the dialog reading
        as a policy document.
      */}
      <View style={styles.section}>
        <Text variant="eyebrow">LINKS</Text>
        {problem === null ? null : (
          <Text variant="meta" testID="share-copy-problem" selectable>
            {problem}
          </Text>
        )}

        <View style={styles.linkRow}>
          <View style={styles.linkMain}>
            {/*
              "Workspace link", not "People with access" — that phrase is
              the heading of the section above now, and a row repeating
              it reads as a second answer to the same question. The two
              rows here are parallel: one link for members, one for
              anybody holding it.
            */}
            <Text variant="rowTitle">Workspace link</Text>
            <Text variant="meta" style={styles.linkNote}>
              {describeTeamLink()}
            </Text>
          </View>
          <Button
            label="Copy link"
            onPress={() => {
              /*
                Minted on demand rather than up front, and the minting
                happens *inside* the copy rather than before it — which
                is what keeps the clipboard reachable on iOS.
              */
              copyAndClose({ kind: "team", path });
            }}
          />
        </View>

        {/*
          Copy and revoke, never mint.

          This row used to carry "Create link", which minted exactly the
          object the padlock's third position minted — two controls for
          one state, on one screen, which is the complaint this whole
          change answers. The audience control above owns whether a link
          exists; this row hands you the one that does.

          Absent entirely when there is none, rather than a row offering
          to copy nothing — and it never mints one either: the audience
          control owns whether a link exists. A folder can have one now;
          it reaches the folder's subtree, filtered to what the workspace
          can already read.
        */}
        {openLink === undefined ? null : (
          <View style={styles.linkRow}>
            <View style={styles.linkMain}>
              <Text variant="rowTitle">Anyone with the link</Text>
              <Text variant="meta" style={styles.linkNote}>
                {describeOpenLink(entryKind)}
              </Text>
            </View>
            <View style={styles.row}>
              <Button
                label="Copy link"
                variant="white"
                onPress={() => copyAndClose({ kind: "link", path })}
                testID="share-open-link"
              />
              <Button
                label="Revoke"
                variant="danger"
                onPress={() => onRevoke(openLink.shareId)}
                testID="share-open-link-revoke"
              />
            </View>
          </View>
        )}

        {openLink === undefined ||
        entryKind === "folder" ||
        onSetCollecting === undefined ? null : (
          <CollectRow share={openLink} onSetCollecting={onSetCollecting} />
        )}

        {namedLink === undefined ||
        context.slug === null ||
        onSetSlug === undefined ? null : (
          <ShortLinkRow
            handle={context.slug}
            share={namedLink}
            onSetSlug={onSetSlug}
          />
        )}

        {/*
          The section's closing line — what a link is the subject of,
          and what nothing here is. `shares.ts` holds the wording and
          records why it is NOT the canvas's: the board says a link
          "never publishes a folder", which stopped being true when a
          folder link arrived.
        */}
        <Text variant="meta" style={styles.linkNote} testID="share-link-reach">
          {describeLinkReach()}
        </Text>
      </View>
    </>
  );
}
