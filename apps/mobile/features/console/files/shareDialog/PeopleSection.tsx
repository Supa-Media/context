import { View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import type { AccessMember, AccessRow } from "../access";
import { describePreviewTitle, shareUrlFor, type NoteShare } from "../shares";
import { Avatar } from "./Avatar";
import { MenuTrigger, type OpenFrom } from "./MenuTrigger";
import type { CopyTarget, ShareDialogProps } from "./props";
import type { ShareMenuItem } from "./ShareMenu";
import { makeStyles } from "./styles";

export type ShowMenu = (
  spec: { id: string; title?: string; items: ShareMenuItem[] },
  measure: Parameters<OpenFrom>[0],
) => void;

/** A person given this note by name, rather than by being in the workspace. */
export function isPersonShare(share: NoteShare): boolean {
  return share.audience === "name" || share.audience === "email";
}

/**
 * PEOPLE WITH ACCESS: the owners, everyone this note was handed to by name,
 * and the group its rule names.
 *
 * One list. The old sheet drew the access rows and the shared-with rows as
 * two lists with two answers — two people above "Not shared with anyone yet"
 * — because each read a different source. Members who reach the note only
 * because the workspace can read it are not listed here: that is what the
 * General access line below says, and it can show them on request.
 */
export function PeopleSection({
  owners,
  groupRow,
  groupCount,
  shares,
  origin,
  compact,
  menuId,
  showMenu,
  copyAndClose,
  onRevoke,
  onSetPreviewTitle,
  onRemovalRoute,
}: {
  owners: readonly AccessMember[];
  groupRow: AccessRow | undefined;
  /** How many people the group reaches, `undefined` while unknown. */
  groupCount: number | undefined;
  shares: readonly NoteShare[] | undefined;
  origin: string;
  compact: boolean;
  menuId: string | null;
  showMenu: ShowMenu;
  copyAndClose: (target: CopyTarget) => void;
  onRevoke: ShareDialogProps["onRevoke"];
  onSetPreviewTitle: ShareDialogProps["onSetPreviewTitle"];
  onRemovalRoute: ShareDialogProps["onRemovalRoute"];
}) {
  const styles = useThemedStyles(makeStyles);
  const people = (shares ?? []).filter(isPersonShare);
  const rowStyle = [styles.row, compact && styles.rowCompact];
  const nameStyle = [styles.name, compact && styles.nameCompact];
  const metaStyle = [styles.meta, compact && styles.metaCompact];

  return (
    <View style={styles.section} testID="share-people">
      <View style={styles.sectionHead}>
        <Text role="heading" aria-level={3} style={[styles.sectionTitle, compact && styles.sectionTitleCompact]}>
          People with access
        </Text>
      </View>

      {owners.map((owner) => {
        const name = owner.name ?? owner.email ?? owner.userId;
        return (
          <View key={owner.userId} style={rowStyle} testID={`share-person-${owner.userId}`}>
            <Avatar label={name} owner compact={compact} />
            <View style={styles.rowMain}>
              <Text style={nameStyle} numberOfLines={1}>
                {`${name}${owner.isMe ? " (you)" : ""}`}
              </Text>
              {owner.name === undefined || owner.email === undefined ? null : (
                <Text variant="meta" style={metaStyle} numberOfLines={1}>
                  {owner.email}
                </Text>
              )}
            </View>
            <Text style={[styles.role, compact && styles.roleCompact]}>Owner</Text>
          </View>
        );
      })}

      {people.map((share) => {
        const id = `share:${share.shareId}`;
        return (
          <View key={share.shareId} style={rowStyle} testID={`share-row-${share.shareId}`}>
            <Avatar label={share.recipient} compact={compact} />
            <View style={styles.rowMain}>
              <Text style={nameStyle} numberOfLines={1}>
                {share.recipient}
              </Text>
              {share.audience !== "email" ? null : (
                <Text variant="meta" style={metaStyle} numberOfLines={1}>
                  Invited by email
                </Text>
              )}
            </View>
            <MenuTrigger
              label="Can read"
              open={menuId === id}
              compact={compact}
              accessibilityLabel={`What ${share.recipient} can do`}
              testID={`share-row-menu-${share.shareId}`}
              onOpen={(measure) =>
                showMenu(
                  {
                    id,
                    title: share.recipient,
                    items: [
                      {
                        id: "can-read",
                        label: "Can read",
                        detail: "This note and the notes it links to",
                        checked: true,
                        onPress: () => {},
                      },
                      {
                        id: "copy",
                        label: "Copy their link",
                        detail: "The link they sign in with",
                        icon: "copy",
                        separatorBefore: true,
                        onPress: () => copyAndClose({ kind: "share", url: shareUrlFor(share, origin) }),
                      },
                      {
                        id: "preview",
                        label: share.titleInPreview
                          ? "Hide the note name in link previews"
                          : "Show the note name in link previews",
                        detail: share.titleInPreview
                          ? describePreviewTitle(share.previewTitle, share.audience)
                          : "Previews show nothing before they sign in",
                        icon: "eye",
                        testID: `share-preview-${share.shareId}`,
                        onPress: () => onSetPreviewTitle(share, !share.titleInPreview),
                      },
                      {
                        id: "remove",
                        label: "Remove access",
                        detail: "Their link stops working",
                        icon: "close",
                        danger: true,
                        separatorBefore: true,
                        testID: `share-revoke-${share.shareId}`,
                        onPress: () => onRevoke(share.shareId),
                      },
                    ],
                  },
                  measure,
                )
              }
            />
          </View>
        );
      })}

      {groupRow === undefined ? null : (
        <View style={rowStyle} testID={`share-person-${groupRow.key}`}>
          <Avatar label={groupRow.label} group compact={compact} />
          <View style={styles.rowMain}>
            <Text style={nameStyle} numberOfLines={1}>
              {groupRow.key}
            </Text>
            <Text variant="meta" style={metaStyle} numberOfLines={2}>
              {groupCount === undefined
                ? "Group"
                : groupCount === 0
                  ? "Group, nobody in it yet"
                  : `Group, ${groupCount} ${groupCount === 1 ? "person" : "people"}`}
            </Text>
          </View>
          {groupRow.removal.length === 0 || onRemovalRoute === undefined ? (
            <Text style={[styles.role, compact && styles.roleCompact]}>Can read</Text>
          ) : (
            <MenuTrigger
              label="Can read"
              open={menuId === `row:${groupRow.key}`}
              compact={compact}
              accessibilityLabel={`What ${groupRow.key} can do`}
              testID={`share-access-remove-${groupRow.key}`}
              onOpen={(measure) =>
                showMenu(
                  {
                    id: `row:${groupRow.key}`,
                    title: groupRow.key,
                    items: [
                      {
                        id: "can-read",
                        label: "Can read",
                        detail: groupRow.reason,
                        checked: true,
                        onPress: () => {},
                      },
                      ...groupRow.removal.map((route, index) => ({
                        id: route.id,
                        label: route.label,
                        detail: route.detail,
                        icon: "gear" as const,
                        separatorBefore: index === 0,
                        testID: `share-route-${route.id}`,
                        onPress: () => onRemovalRoute(route, groupRow),
                      })),
                    ],
                  },
                  measure,
                )
              }
            />
          )}
        </View>
      )}

      {shares === undefined ? (
        <Text variant="meta" style={metaStyle}>
          Checking who else has it…
        </Text>
      ) : null}
    </View>
  );
}
