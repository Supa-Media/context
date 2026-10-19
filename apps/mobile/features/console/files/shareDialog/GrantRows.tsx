import { Pressable, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { contextHandle, type AudienceContext } from "../../privacy/audience";
import { baseName, folderLabel } from "../paths";
import { Avatar } from "./Avatar";
import { displayName } from "./copy";
import {
  backToFolder,
  grantDetail,
  grantKey,
  grantLabel,
  ownCopy,
  removeGrant,
  roleLabel,
  setRole,
  peopleOf,
  type GrantEntry,
  type GrantWrite,
} from "./grants";
import { MenuTrigger } from "./MenuTrigger";
import type { ShowMenu } from "./PeopleSection";
import { makeStyles } from "./styles";
import type { ShareGrants } from "./useShareGrants";

/**
 * The people, groups and emails a note is shared with, each with Can view or Can edit (boards 1 to 4).
 *
 * A note that sets nothing follows its folder's list, and says so: the folder's people are shown with their roles
 * as text, and the one control is "Give this note its own list", which copies them (board 3). A note with a list of
 * its own can go back to the folder's. The rest of the workspace is the General access line below, not a row here.
 */
export function GrantRows({
  path,
  grants,
  context,
  compact,
  menuId,
  showMenu,
  onWrite,
}: {
  path: string;
  grants: ShareGrants;
  context: AudienceContext;
  compact: boolean;
  menuId: string | null;
  showMenu: ShowMenu;
  /** Sends one write, and shows its refusal where the dialog shows problems. */
  onWrite: (write: GrantWrite) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { list } = grants;
  const handle = contextHandle(context.slug);
  const rowStyle = [styles.row, compact && styles.rowCompact];
  const nameStyle = [styles.name, compact && styles.nameCompact];
  const metaStyle = [styles.meta, compact && styles.metaCompact];
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;

  const row = (entry: GrantEntry, editable: boolean) => {
    const key = grantKey(entry);
    const label = grantLabel(entry);
    const id = `grant:${key}`;
    return (
      <View key={key} style={rowStyle} testID={`share-grant-${key}`}>
        <Avatar label={label} group={entry.kind === "group"} compact={compact} />
        <View style={styles.rowMain}>
          <Text style={nameStyle} numberOfLines={1}>
            {label}
          </Text>
          <Text variant="meta" style={metaStyle} numberOfLines={1}>
            {grantDetail(entry, handle)}
          </Text>
        </View>
        {!editable ? (
          <Text style={[styles.role, compact && styles.roleCompact, { flexShrink: 0 }]} numberOfLines={1}>
            {roleLabel(entry.role)}
          </Text>
        ) : (
          <MenuTrigger
            label={roleLabel(entry.role)}
            open={menuId === id}
            compact={compact}
            accessibilityLabel={`What ${label} can do`}
            testID={`share-grant-menu-${key}`}
            onOpen={(measure) =>
              showMenu(
                {
                  id,
                  title: label,
                  items: [
                    {
                      id: "view",
                      label: "Can view",
                      detail: "Read it, nothing more",
                      checked: entry.role === "view",
                      testID: `share-grant-view-${key}`,
                      onPress: () => entry.role !== "view" && onWrite(setRole(list, key, "view")),
                    },
                    {
                      id: "edit",
                      label: "Can edit",
                      detail: "Read it and change it",
                      checked: entry.role === "edit",
                      testID: `share-grant-edit-${key}`,
                      onPress: () => entry.role !== "edit" && onWrite(setRole(list, key, "edit")),
                    },
                    {
                      id: "remove",
                      label: "Remove",
                      detail: "They can't open it any more",
                      icon: "close",
                      danger: true,
                      separatorBefore: true,
                      testID: `share-grant-remove-${key}`,
                      onPress: () => onWrite(removeGrant(list, key)),
                    },
                  ],
                },
                measure,
              )
            }
          />
        )}
      </View>
    );
  };

  if (list.from !== null) {
    const folder = displayName(folderLabel(baseName(list.from)));
    return (
      <View style={styles.section} testID="share-grants-inherited">
        <View style={styles.rowMain}>
          <Text style={nameStyle}>{`Shared like its folder, ${folder}`}</Text>
          <Text variant="meta" style={metaStyle}>
            {`Everyone the folder is shared with can open this ${list.kind === "folder" ? "folder" : "note"}. Change the folder and this follows.`}
          </Text>
        </View>
        {peopleOf(list).map((entry) => row(entry, false))}
        <Pressable
          accessibilityLabel="Give this its own list"
          role="button"
          testID="share-grants-own"
          disabled={grants.saving}
          style={[styles.footButton, styles.smallButton, { alignSelf: "flex-start", marginTop: 6 }]}
          onPress={() => onWrite(ownCopy(list))}
        >
          <Text style={styles.footLabel}>{`Give this ${list.kind === "folder" ? "folder" : "note"} its own list`}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      {/* The members grant is the General access line's Members position, never a row here. */}
      {peopleOf(list).map((entry) => row(entry, true))}
      {parent === null || (list.base === null && list.grantees.length === 0) ? null : (
        <Text
          variant="meta"
          style={[metaStyle, styles.link, { paddingVertical: 8 }]}
          role="button"
          testID="share-grants-back"
          onPress={() => !grants.saving && onWrite(backToFolder())}
        >
          {`Go back to sharing like the folder, ${displayName(folderLabel(baseName(parent)))}`}
        </Text>
      )}
    </>
  );
}
