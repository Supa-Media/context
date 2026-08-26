import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Check } from "../../design/components/Field";
import { ChoiceGroup, FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import {
  DESCRIPTION_PURPOSE,
  PRIVACY_DEFAULT_NOTE,
  REVERSIBLE_NOTE,
  addFolderRow,
  canAddFolderRow,
  describeOutcome,
  paraFolderLines,
  removeFolderRow,
  setFolderRow,
  type StructureTemplate,
} from "../structure";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 3 — a starting layout, offered as help rather than as a decision.
 *
 * Two rules shape this screen, and both of them are about doing less.
 *
 * **If the bucket already holds a context, there is no question.** The most
 * valuable thing this product can do for somebody with a vault that has been
 * running for years is nothing at all: no migration, no rewrite, no request to
 * re-approve a structure they settled on long ago. So the flow reports what it
 * found and moves on. The scaffolder could not overwrite them even if it tried
 * — `hasExistingContext` refuses and every write is preceded by an existence
 * check — and saying that out loud is more reassuring than asking permission we
 * do not need.
 *
 * **If it is empty, this is a suggestion.** PARA is a starting shape, not a
 * schema; the tools address paths and nothing below them cares. Which is why
 * the last line on the screen says the whole thing is changeable later, in the
 * console or by asking a connected AI client — that is what makes picking wrong
 * cost nothing, and it is the reason no confirmation step is needed here.
 */
export function StructureStep({ controller }: { controller: OnboardingController }) {
  if (controller.structureStep.kind === "existing") {
    return <ExistingContext controller={controller} />;
  }
  return <ChooseLayout controller={controller} />;
}

/** The bucket already had a context. Report, do not prompt. */
function ExistingContext({ controller }: { controller: OnboardingController }) {
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Your bucket already has a context in it, so nothing was changed.
      </Text>

      <Card>
        <View style={styles.checks}>
          <Check tone="ok">Your existing folders and notes are exactly as you left them.</Check>
          <Check tone="ok">Nothing was moved, renamed, or rewritten — and nothing will be.</Check>
          <Check tone="ok">
            Anything already syncing to this bucket, Obsidian included, keeps working.
          </Check>
        </View>
        <Text variant="rowSub" style={styles.cardNote}>
          Context reads what is there rather than imposing a shape on it. Files stay where they
          are, at the paths they already have.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button
          label="Continue"
          variant="white"
          onPress={controller.skipStructure}
          testID="welcome-structure-continue"
        />
      </View>
    </View>
  );
}

/** The bucket is empty. Offer a shape. */
function ChooseLayout({ controller }: { controller: OnboardingController }) {
  const { template, folders, applying, structureFailure } = controller;

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Your bucket is empty, so here is a starting shape. Pick the one that suits how you
        already think — neither is a schema, and the tools work the same either way.
      </Text>

      <ChoiceGroup<StructureTemplate>
        label="Starting layout"
        options={[
          {
            value: "para",
            label: "PARA (recommended)",
            detail: "Five folders and a manifest. A well-worn shape that suits most people.",
          },
          {
            value: "custom",
            label: "My own",
            detail: "Name your own top-level folders. Best if you already have a system.",
          },
        ]}
        value={template}
        onChange={controller.setTemplate}
        disabled={applying}
        testID="welcome-template"
      />

      {template === "para" ? <ParaPreview /> : <CustomFolders controller={controller} />}

      <Text variant="foot" style={styles.note}>
        {PRIVACY_DEFAULT_NOTE}
      </Text>
      <Text variant="foot" style={styles.noteTight}>
        {REVERSIBLE_NOTE}
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
          testID="welcome-structure-submit"
        />
        <Button
          label="Skip for now"
          variant="ghost"
          disabled={applying}
          onPress={controller.skipStructure}
          testID="welcome-structure-skip"
        />
      </View>

      <Text variant="foot" style={styles.outcome}>
        {describeOutcome(template, folders)}
      </Text>
    </View>
  );
}

/** What PARA actually creates, in the real folder names. */
function ParaPreview() {
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
          The manifest — what this context is and how it is organised.
        </Text>
      </View>
      <View style={styles.previewRow}>
        <Text variant="mono" style={styles.previewName}>
          privacy.md
        </Text>
        <Text variant="rowSub" style={styles.previewLine}>
          What a connected AI client may see. Everything starts private.
        </Text>
      </View>
    </Card>
  );
}

/** Name your own. A plain repeatable row and nothing clever. */
function CustomFolders({ controller }: { controller: OnboardingController }) {
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
            placeholder="clients"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!applying}
            error={folderErrors[index]}
            testID={`welcome-folder-name-${index}`}
          />
          <TextField
            containerStyle={styles.folderDescription}
            label={index === 0 ? "What goes in it" : ""}
            accessibilityLabel={`Folder ${index + 1} description`}
            value={row.description}
            onChangeText={(text) =>
              setFolders(setFolderRow(folders, index, { description: text }))
            }
            placeholder="Everything to do with a client engagement"
            editable={!applying}
            testID={`welcome-folder-description-${index}`}
          />
          <View style={index === 0 ? styles.removeFirst : styles.remove}>
            <Button
              label="Remove"
              accessibilityLabel={`Remove folder ${index + 1}`}
              variant="ghost"
              disabled={applying}
              onPress={() => setFolders(removeFolderRow(folders, index))}
              testID={`welcome-folder-remove-${index}`}
            />
          </View>
        </View>
      ))}

      <View style={styles.addRow}>
        <Button
          label="Add a folder"
          disabled={applying || !canAddFolderRow(folders)}
          onPress={() => setFolders(addFolderRow(folders))}
          testID="welcome-folder-add"
        />
        <Text variant="foot" style={styles.addNote}>
          Name at least one — three is plenty to start with, and the console adds the rest.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  checks: { gap: 9 },
  cardNote: { marginTop: 13, lineHeight: leading(12.5, 1.7) },
  preview: { marginTop: 16 },
  previewRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 10, paddingVertical: 4 },
  previewName: { width: 116, color: colors.codeKey },
  previewLine: { flex: 1, minWidth: 200 },
  custom: { marginTop: 16 },
  customLede: { marginBottom: 14, lineHeight: leading(12.5, 1.7) },
  folderRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 12,
  },
  folderName: { flexGrow: 1, flexShrink: 1, flexBasis: 150, minWidth: 0 },
  folderDescription: { flexGrow: 3, flexShrink: 1, flexBasis: 240, minWidth: 0 },
  remove: { paddingTop: 8 },
  removeFirst: { paddingTop: 30 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  addNote: { flex: 1, minWidth: 220, lineHeight: leading(12.5, 1.6) },
  note: { marginTop: 18, lineHeight: leading(12.5, 1.7) },
  noteTight: { marginTop: 8, lineHeight: leading(12.5, 1.7) },
  failure: { marginTop: 16 },
  actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  outcome: { marginTop: 12 },
});
