/**
 * The rollout's workspaces, in the order the server returns them: the ones
 * that need attention first. A table under a pointer, two-line rows on a
 * phone, like every other list in the staff console.
 */

import { StyleSheet, View } from "react-native";
import { Pill, Text, useThemedStyles, type Colors } from "../design";
import { useCompact } from "./AdminKit";
import { ListRow, TableHead, TableRow, type Column } from "./AdminTable";
import { workspaceFiles, workspaceStatePill, type RolloutWorkspace } from "./encryption";

const COLUMNS: readonly Column[] = [
  { label: "Workspace", flex: 2 },
  { label: "State", flex: 1 },
  { label: "Files", flex: 1, align: "right" },
];

export function EncryptionWorkspaces({ workspaces }: { workspaces: readonly RolloutWorkspace[] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();

  if (compact) {
    return (
      <View testID="admin-encryption-workspaces">
        {workspaces.map((workspace, index) => {
          const pill = workspaceStatePill(workspace.state, workspace.errorCode);
          return (
            <ListRow
              key={workspace.workspaceId}
              first={index === 0}
              title={`@${workspace.slug}`}
              sub={`${workspaceFiles(workspace)} files`}
              trailing={<Pill tone={pill.tone}>{pill.label}</Pill>}
              testID={`admin-encryption-row-${workspace.slug}`}
            />
          );
        })}
      </View>
    );
  }

  return (
    <View testID="admin-encryption-workspaces">
      <TableHead columns={COLUMNS} />
      {workspaces.map((workspace, index) => {
        const pill = workspaceStatePill(workspace.state, workspace.errorCode);
        return (
          <TableRow
            key={workspace.workspaceId}
            columns={COLUMNS}
            last={index === workspaces.length - 1}
            testID={`admin-encryption-row-${workspace.slug}`}
            cells={[
              <Text key="slug" variant="rowTitle" numberOfLines={1}>
                @{workspace.slug}
              </Text>,
              <Pill key="state" tone={pill.tone}>
                {pill.label}
              </Pill>,
              <Text key="files" variant="meta" style={styles.num}>
                {workspaceFiles(workspace)}
              </Text>,
            ]}
          />
        );
      })}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    num: { fontVariant: ["tabular-nums"], textAlign: "right" },
  });
