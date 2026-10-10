import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { useColors, useThemedStyles } from "../../../design/theme";
import { MembersSection } from "../../members/MembersSection";
import { shareBackSuggestions } from "../../members/members";
import { selectedContext, type ConsoleData } from "../../types";
import { GroupsPanel } from "./GroupsPanel";
import { OrganizationCard } from "./OrganizationCard";
import { PanelHead } from "./PanelHead";
import type { SettingsSectionKey } from "../sections";
import { PrivacyPanel } from "./PrivacyPanel";
import { SharedLinksPanel } from "./SharedLinksPanel";

/**
 * Settings › People & sharing: who is here, who sees each folder, what was
 * handed out one link at a time, and (one press deeper) groups and activity.
 *
 * Presentation only: `PrivacyPanel` still reads the live manifest through the
 * same pure modules, and the members, groups and shares views are the same
 * owner-gated shapes they were.
 */
export function SharingSection({
  data,
  sectioned,
  onSelect,
}: {
  data: ConsoleData;
  sectioned: boolean;
  /** Absent on the landing-page demo: the activity link is then left out. */
  onSelect?: (key: SettingsSectionKey) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const current = selectedContext(data);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groups = data.groups?.groups ?? [];
  const names = groups.map((group) => group.label).join(", ");
  return (
    <>
      <PanelHead section="sharing" sectioned={sectioned}>
        Who can open this workspace.
      </PanelHead>

      <MembersSection
        view={data.members}
        viewerRole={current?.role}
        showReachRule={false}
        /*
          Defensive because this pane is rendered from fixtures that carry only
          the half of `members` their own subject needs. A missing invitations
          list is "nobody to suggest", not a crash.
        */
        shareBackWith={
          Array.isArray(data.members?.invitations)
            ? shareBackSuggestions(data.contexts, data.members)
            : []
        }
      />

      {current !== null && current.kind === "shared" && current.role === "owner" && !data.demo ? (
        <View style={styles.block}>
          <OrganizationCard workspaceId={current.id} />
        </View>
      ) : null}

      <View style={styles.block}>
        <PrivacyPanel data={data} />
      </View>

      <View style={styles.block}>
        <SharedLinksPanel view={data.shares} />
      </View>

      <View style={styles.block}>
        <Pressable
          role="button"
          aria-expanded={groupsOpen}
          accessibilityLabel={`Groups${groups.length > 0 ? `, ${groups.length}` : ""}`}
          onPress={() => setGroupsOpen((open) => !open)}
          style={styles.groupsRow}
          testID="sharing-groups-toggle"
        >
          <Icon name={groupsOpen ? "chevronDown" : "chevronRight"} size={13} color={colors.text2} />
          <Text variant="rowTitle">Groups</Text>
          <Text variant="rowSub" numberOfLines={1} style={styles.groupsNames}>
            {groups.length === 0 ? "None yet" : `${groups.length} · ${names}`}
          </Text>
        </Pressable>
        {groupsOpen ? (
          <View style={styles.groupsBody}>
            <GroupsPanel
              bare
              view={data.groups}
              members={data.members.members}
              slug={current?.slug.replace(/^@/, "") ?? ""}
            />
          </View>
        ) : null}
        {onSelect !== undefined ? (
          <TextLink
            label="Who changed what"
            onPress={() => onSelect("activity")}
            testID="sharing-activity-link"
          />
        ) : null}
      </View>
    </>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    block: { marginTop: 28 },
    groupsRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
    groupsNames: { flexShrink: 1 },
    groupsBody: { marginTop: 8, marginBottom: 8 },
  });
