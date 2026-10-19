import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import type { IconName } from "../../../design/components/icons/names";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import { audienceName, contextHandle, type AudienceContext } from "../../privacy/audience";
import type { AccessRow } from "../access";
import { baseName, folderLabel } from "../paths";
import type { NoteScope } from "../scope";
import { audiencePositions, scopeLabels } from "../scope";
import { Avatar } from "./Avatar";
import { allUsersConfirmLine, ALL_USERS_TAG, goingPublicLine, displayName, scopeLine } from "./copy";
import { MenuTrigger } from "./MenuTrigger";
import type { ShowMenu } from "./PeopleSection";
import type { ShareDialogProps } from "./props";
import { makeStyles } from "./styles";

const SCOPE_ICON: Record<NoteScope, IconName> = { private: "lock", members: "people", team: "people", anyone: "globe" };

/** A widening that asks first, in place: a public link, or All Context users in the pinned workspace. */
export type Confirming = "anyone" | "team" | null;

/**
 * Whether picking `to` from `from` asks first. Going public always does. In the pinned workspace, where `team` is
 * every signed-in Context account and signing up is open, reaching it from Restricted or Members does too. Leaving
 * it, or reaching it from a link (a narrowing), never asks.
 */
export function asksFirst(from: NoteScope, to: NoteScope, everyAccount: boolean): Confirming {
  if (to === from) return null;
  if (to === "anyone") return "anyone";
  if (to === "team" && everyAccount && (from === "private" || from === "members")) return "team";
  return null;
}

/** The folder a path sits in, named the way the tree names it. */
function parentName(path: string): string | undefined {
  const parts = path.replace(/\/+$/, "").split("/");
  if (parts.length < 2) return undefined;
  return displayName(folderLabel(baseName(parts.slice(0, -1).join("/"))));
}

/**
 * GENERAL ACCESS: one line saying who else can open this, with the one control
 * that changes it.
 *
 * A dropdown rather than the segmented control it replaces. Three segments
 * split the sheet's width by three and truncated "Everyone in @public-worship"
 * inside the middle one, and then two more lines underneath had to say what
 * the chosen segment meant. Here the row says it once, and the menu says it
 * for each choice before it is made.
 *
 * Going public still asks first — in place, as one sentence and a button,
 * rather than as a red panel — and narrowing never asks, for the reason
 * `scope.ts` gives: a dialog that confirms making something more private
 * teaches people to dismiss the one confirmation that mattered.
 */
export function GeneralAccess({
  path,
  name,
  access,
  scope,
  entryKind,
  context,
  compact,
  memberRows,
  people,
  confirming,
  setConfirming,
  menuId,
  showMenu,
  onSetScope,
  onRemovalRoute,
  membersWritable = false,
  children,
}: {
  path: string;
  name: string;
  access: NonNullable<ShareDialogProps["access"]>;
  scope: NoteScope;
  entryKind: "file" | "folder";
  context: AudienceContext;
  compact: boolean;
  /** Members who reach this through the workspace, owners excluded. */
  memberRows: readonly AccessRow[];
  /** How many people this was handed to by name. */
  people: number;
  confirming: Confirming;
  setConfirming: Dispatch<SetStateAction<Confirming>>;
  menuId: string | null;
  showMenu: ShowMenu;
  onSetScope: ShareDialogProps["onSetScope"];
  onRemovalRoute: ShareDialogProps["onRemovalRoute"];
  /** Whether the Members position can be written here: the note's own list is loaded (`grants`). */
  membersWritable?: boolean;
  /** The link's own options, drawn under the line when a link exists. */
  children?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [showMembers, setShowMembers] = useState(false);
  const triggerRef = useRef<View>(null);
  const labels = scopeLabels(context);
  const everyAccount = context.everyAccount === true;
  // A members grant is the Members position, decided before a note's other names could read as a group.
  const group = scope !== "members" && access.visibility !== "team" && access.visibility !== "private";
  /*
    Everyone in the workspace, counted: owners are members too. `undefined`
    while the membership is loading, which the line says as "Every member".
  */
  const memberCount = access.members?.length;
  const shown: NoteScope = confirming ?? scope;
  // The "reaches past this workspace" look: a link, and All Context users in the pinned workspace.
  const wide = shown === "anyone" || (shown === "team" && everyAccount);
  const line = (position: NoteScope) =>
    scopeLine(position, context, { kind: entryKind, memberCount, people });

  const pick = (position: NoteScope) => {
    if (position === scope || onSetScope === undefined) return;
    const ask = asksFirst(scope, position, everyAccount);
    if (ask !== null) {
      setConfirming(ask);
      return;
    }
    setConfirming(null);
    onSetScope(scope, position);
  };

  const openAudience = () => {
    showMenu(
      {
        id: "audience",
        title: `Who can open ${name}`,
        items: audiencePositions({ everyAccount, membersWritable, scope }).map((position) => ({
          id: position,
          label: labels[position].label,
          detail: line(position),
          icon: position === "team" && everyAccount ? "group" : SCOPE_ICON[position],
          checked: position === scope,
          testID: `share-audience-${position}`,
          onPress: () => pick(position),
        })),
      },
      (done) =>
        triggerRef.current?.measureInWindow((x, y, width, height) => done({ x, y, width, height })),
    );
  };

  const folder = parentName(path);
  const inherited = !access.exception && !group;
  const labelStyle = [styles.audienceLabel, compact && styles.audienceLabelCompact];

  return (
    <View style={styles.section} testID="share-access">
      <View style={styles.sectionHead}>
        <Text role="heading" aria-level={3} style={[styles.sectionTitle, compact && styles.sectionTitleCompact]}>
          General access
        </Text>
      </View>

      <View style={[styles.row, styles.rowTop]}>
        <View
          style={[
            styles.tile,
            compact && styles.tileCompact,
            wide && styles.tileLive,
          ]}
        >
          <Icon
            name={group ? "lock" : shown === "team" && everyAccount ? "group" : SCOPE_ICON[shown]}
            size={18}
            color={wide ? colors.accent : colors.text2}
          />
        </View>
        <View style={styles.rowMain}>
          {group ? (
            <Text style={labelStyle} testID="share-scope-group">
              {audienceName("private", context)}
            </Text>
          ) : onSetScope === undefined ? (
            <Text style={labelStyle}>{labels[shown].label}</Text>
          ) : (
            <Pressable
              ref={triggerRef}
              style={[styles.audienceTrigger, menuId === "audience" && styles.dropdownOpen]}
              accessibilityLabel={`Who can open it: ${labels[shown].label}`}
              aria-haspopup="menu"
              aria-expanded={menuId === "audience"}
              testID="share-audience"
              onPress={openAudience}
            >
              <Text style={labelStyle}>{labels[shown].label}</Text>
              <Icon name="chevronDown" size={14} color={colors.muted} />
            </Pressable>
          )}

          <Text variant="meta" style={[styles.meta, compact && styles.metaCompact]}>
            {confirming === "anyone"
              ? "Not public yet"
              : confirming === "team"
                ? "Not open to them yet"
                : group
                  ? "Only owners and the group above can open it"
                  : line(scope)}
            {/* Who the members are, where they are who it reaches: never under All Context users. */}
            {confirming === null && (scope === "members" || (scope === "team" && !everyAccount)) && memberRows.length > 0 ? (
              <Text
                variant="meta"
                style={[styles.link, compact && styles.metaCompact]}
                role="button"
                testID="share-see-members"
                onPress={() => setShowMembers((open) => !open)}
              >
                {showMembers ? " · Hide members" : " · See members"}
              </Text>
            ) : null}
          </Text>

          {/*
            All Context users says its reach in the tag's place: the reach matters more than where the setting came
            from, and two stacked tags would be clunky. Neutral, as the folder tag is: no new hue for a warning.
          */}
          {confirming === null && scope === "team" && everyAccount ? (
            <View style={styles.tag} testID="share-all-users-note">
              <Icon name="info" size={14} color={colors.muted} />
              <Text variant="meta" style={styles.meta}>
                {ALL_USERS_TAG}
              </Text>
            </View>
          ) : null}

          {/* A public link is its own grant; "from the folder" would misread it. */}
          {inherited && confirming === null && scope !== "anyone" && !(scope === "team" && everyAccount) && !(entryKind === "folder" && folder === undefined) ? (
            <View style={styles.tag} testID="share-inherited">
              <Icon name="folder" size={14} color={colors.muted} />
              <Text variant="meta" style={styles.meta}>
                {entryKind === "folder" || folder === undefined
                  ? "From the folder above"
                  : `From the folder ${folder}`}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {confirming === null ? null : (
        <View style={styles.confirm} testID={confirming === "team" ? "share-confirm-all-users" : "share-confirm-public"}>
          <Text variant="meta" style={[styles.confirmText, compact && styles.metaCompact]}>
            {confirming === "team"
              ? allUsersConfirmLine(name, entryKind, contextHandle(context.slug), memberCount)
              : goingPublicLine(name, entryKind)}
          </Text>
          <View style={styles.confirmActions}>
            <Pressable
              accessibilityLabel="Cancel"
              style={[styles.footButton, styles.smallButton, styles.ghostButton]}
              onPress={() => setConfirming(null)}
            >
              <Text style={[styles.footLabel, { color: colors.text2 }]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={confirming === "team" ? "Open to all users" : "Create link"}
              testID={confirming === "team" ? "share-confirm-all-users-yes" : "share-confirm-public-yes"}
              style={[styles.footButton, styles.smallButton, styles.footPrimary]}
              onPress={() => {
                setConfirming(null);
                onSetScope?.(scope, confirming);
              }}
            >
              <Text style={[styles.footLabel, styles.footPrimaryLabel]}>
                {confirming === "team" ? "Open to all users" : "Create link"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {showMembers && (scope === "members" || (scope === "team" && !everyAccount)) && confirming === null ? (
        <View style={[compact ? styles.indentCompact : styles.indent, styles.subList]} testID="share-members">
          {memberRows.map((row) => {
            const id = `row:${row.key}`;
            const canRemove = row.removal.length > 0 && onRemovalRoute !== undefined;
            return (
              <View key={row.key} style={styles.row} testID={`share-member-${row.key}`}>
                <Avatar label={row.label} compact={compact} />
                <View style={styles.rowMain}>
                  <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
                    {row.label}
                  </Text>
                </View>
                {!canRemove ? (
                  <Text style={[styles.role, compact && styles.roleCompact]}>Can read</Text>
                ) : (
                  <MenuTrigger
                    label="Can read"
                    open={menuId === id}
                    compact={compact}
                    accessibilityLabel={`What ${row.label} can do`}
                    testID={`share-access-remove-${row.key}`}
                    onOpen={(measure) =>
                      showMenu(
                        {
                          id,
                          title: `${row.label} reads this as a member`,
                          items: [
                            {
                              id: "can-read",
                              label: "Can read",
                              detail: `Through ${contextHandle(context.slug)}`,
                              checked: true,
                              onPress: () => {},
                            },
                            ...row.removal.map((route, index) => ({
                              id: route.id,
                              label: route.label,
                              detail: route.detail,
                              icon: route.danger ? ("close" as const) : ("lock" as const),
                              danger: route.danger,
                              separatorBefore: index === 0 || route.danger,
                              testID: `share-route-${route.id}`,
                              onPress: () => onRemovalRoute(route, row),
                            })),
                          ],
                        },
                        measure,
                      )
                    }
                  />
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      {confirming !== null || children === undefined ? null : children}
    </View>
  );
}
