import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { ChoiceGroup, FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  DESCRIPTION_PURPOSE,
  addFolderRow,
  canAddFolderRow,
  paraFolderLines,
  removeFolderRow,
  setFolderRow,
} from "../../onboarding/structure";
import { WORKSPACE_LAYOUT_NOTE, WORKSPACE_PRIVACY_NOTE } from "../create";
import { WORKSPACE_PRESETS, type WorkspacePresetKey } from "../presets";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 3 — the starting layout.
 *
 * ## Why the presets are not PARA
 *
 * PARA sorts one person's work by how permanent it is, which is the right
 * question for a brain and the wrong one for a company — see `../presets`. So
 * the default here is a company shape, PARA is offered third for teams that
 * already use it, and every preset is editable in place: choosing "Company" and
 * renaming `4-customers` is the common case, not an escape hatch.
 *
 * The rows are the same editor onboarding uses, with the same validator, for
 * the same reason: a folder name here becomes a key prefix in somebody's own
 * bucket, and there must be exactly one set of rules about what may be one.
 *
 * ## The privacy line is not the same line onboarding shows
 *
 * Onboarding's says everything starts private. A workspace's folders start
 * team-visible, and `private` in a workspace means *owners* rather than
 * *me* — which is the thing somebody will otherwise learn by marking a folder
 * private and locking out their co-lead. See `WORKSPACE_PRIVACY_NOTE`.
 */
export function WorkspaceLayoutStep({
  controller,
}: {
  controller: CreateWorkspaceController;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { preset, applying, structureFailure } = controller;

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        The bucket is empty, so here is a starting shape. These are suggestions in the shape of
        folders — pick the one closest to how the team already works and edit it in place.
      </Text>

      <ChoiceGroup<WorkspacePresetKey>
        label="Starting layout"
        options={WORKSPACE_PRESETS.map((entry) => ({
          value: entry.key,
          label: entry.key === "company" ? `${entry.label} (recommended)` : entry.label,
          detail: entry.summary,
        }))}
        value={preset}
        onChange={controller.setPreset}
        disabled={applying}
        testID="workspace-preset"
      />

      {preset === "para" ? <ParaPreview /> : <FolderRows controller={controller} />}

      <Text variant="foot" style={styles.note}>
        {WORKSPACE_PRIVACY_NOTE}
      </Text>
      <Text variant="foot" style={styles.noteTight}>
        {WORKSPACE_LAYOUT_NOTE}
      </Text>

      {structureFailure ? (
        <FormError
          headline={structureFailure.headline}
          next={structureFailure.next}
          style={styles.failure}
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={applying ? "Creating…" : "Create these"}
          variant="white"
          disabled={!controller.canApply}
          onPress={() => void controller.applyStructure()}
          trailing={applying ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="workspace-layout-submit"
        />
        <Button
          label="Skip for now"
          variant="ghost"
          disabled={applying}
          onPress={controller.skipStructure}
          testID="workspace-layout-skip"
        />
      </View>
    </View>
  );
}

/** What PARA actually creates, from the control plane's own folder list. */
function ParaPreview() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.preview}>
      {paraFolderLines().map(({ folder, line }) => (
        <View key={folder} style={styles.previewRow}>
          <Text variant="mono" style={styles.previewName}>
            {`${folder}/`}
          </Text>
          <Text variant="rowSub" style={styles.previewLine}>
            {line}
          </Text>
        </View>
      ))}
      <View style={styles.previewRow}>
        <Text variant="mono" style={styles.previewName}>
          index.md
        </Text>
        <Text variant="rowSub" style={styles.previewLine}>
          The manifest — what this workspace is and how it is organised.
        </Text>
      </View>
      <View style={styles.previewRow}>
        <Text variant="mono" style={styles.previewName}>
          privacy.md
        </Text>
        <Text variant="rowSub" style={styles.previewLine}>
          What a connected AI client may see. These folders start open to the workspace.
        </Text>
      </View>
    </Card>
  );
}

/**
 * The preset's folders, editable.
 *
 * Not a preview and not a locked list: a preset is a starting *value* for this
 * editor, so the same rows serve "Company", "Client work" and "Name your own".
 * That is why the heading below says what it says — somebody who picked a
 * preset should see immediately that these are theirs to change, rather than
 * hunting for a "customise" button.
 */
function FolderRows({ controller }: { controller: CreateWorkspaceController }) {
  const styles = useThemedStyles(makeStyles);
  const { folders, folderErrors, applying, setFolders } = controller;

  return (
    <View style={styles.custom}>
      <Text variant="rowSub" style={styles.customLede}>
        {DESCRIPTION_PURPOSE}
      </Text>

      {folders.map((row, index) => (
        <View key={index} style={styles.folderRow}>
          <TextField
            containerStyle={styles.folderName}
            label={index === 0 ? "Folder" : ""}
            accessibilityLabel={`Folder ${index + 1} name`}
            value={row.name}
            onChangeText={(text) => setFolders(setFolderRow(folders, index, { name: text }))}
            placeholder="3-handbook"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!applying}
            error={folderErrors[index]}
            testID={`workspace-folder-name-${index}`}
          />
          <TextField
            containerStyle={styles.folderDescription}
            label={index === 0 ? "What goes in it" : ""}
            accessibilityLabel={`Folder ${index + 1} description`}
            value={row.description}
            onChangeText={(text) =>
              setFolders(setFolderRow(folders, index, { description: text }))
            }
            placeholder="How this company works: decisions, policies, onboarding"
            editable={!applying}
            testID={`workspace-folder-description-${index}`}
          />
          <View style={index === 0 ? styles.removeFirst : styles.remove}>
            <Button
              label="Remove"
              accessibilityLabel={`Remove folder ${index + 1}`}
              variant="ghost"
              disabled={applying}
              onPress={() => setFolders(removeFolderRow(folders, index))}
              testID={`workspace-folder-remove-${index}`}
            />
          </View>
        </View>
      ))}

      <View style={styles.addRow}>
        <Button
          label="Add a folder"
          disabled={applying || !canAddFolderRow(folders)}
          onPress={() => setFolders(addFolderRow(folders))}
          testID="workspace-folder-add"
        />
        <Text variant="foot" style={styles.addNote}>
          Name at least one. Fewer, clearer folders beat a taxonomy nobody files into.
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  preview: { marginTop: 16, gap: 10 },
  previewRow: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  previewName: { color: colors.text2, minWidth: 96 },
  previewLine: { flex: 1, minWidth: 180 },
  custom: { marginTop: 16 },
  customLede: { marginBottom: 14, lineHeight: leading(12.5, 1.7) },
  folderRow: { flexDirection: "row", gap: 10, flexWrap: "wrap", marginBottom: 12 },
  folderName: { flexGrow: 1, flexBasis: 150 },
  folderDescription: { flexGrow: 3, flexBasis: 240 },
  remove: { justifyContent: "center" },
  removeFirst: { justifyContent: "flex-end", paddingBottom: 4 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  addNote: { flex: 1, minWidth: 200 },
  note: { marginTop: 18, lineHeight: leading(12.5, 1.7) },
  noteTight: { marginTop: 8, lineHeight: leading(12.5, 1.7) },
  failure: { marginTop: 16 },
  actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14 },
});
