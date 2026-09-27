import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../design/components/Button";
import { TextLink } from "../../design/components/TextLink";
import { Card, Row } from "../../design/components/Card";
import { ChoiceGroup, FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  PRIVACY_DEFAULT_NOTE,
  REVERSIBLE_NOTE,
  paraFolderLines,
  toApplyStructureArgs,
} from "../../onboarding/structure";
import { WORKSPACE_PRIVACY_NOTE } from "../../workspace/create";
import {
  DEFAULT_PRESET,
  WORKSPACE_PRESETS,
  presetRows,
  templateFor,
  type WorkspacePresetKey,
} from "../../workspace/presets";
import { setupCopy, type ContextSetup } from "../setup";

/**
 * The offer an abandoned setup flow leaves behind.
 *
 * Drawn in the console's notice band, in the same column as the bucket and
 * privacy notices, because that is where somebody who never finished
 * `/welcome` or `/workspace/new` actually arrives — see `../setup.ts` for when
 * it is drawn at all, which is the more interesting half.
 *
 * ## Two answers, and they are the flows' own two answers
 *
 * **A starting layout**, which is `applyStructure` with the standard template
 * — the same mutation, the same five folders, the same server-side guards. Not
 * a second scaffolder and not a second opinion about what PARA is: the folder
 * names are imported from the scaffolder itself so they cannot drift from what
 * gets written.
 *
 * **A vault they already have**, which is not reimplemented here at all. The
 * importer lives in Settings → Storage and has since before this card existed;
 * this sends people to it. A second copy of an import that clears and rewrites
 * a bucket is the last thing this codebase needs, and a person who has just
 * been told their context is empty is exactly the person who should see the
 * importer's own warnings rather than a shortened version of them.
 *
 * ## A shared workspace is asked what kind it is
 *
 * The managed-storage route out of `/workspace/new` skips its "What kind of
 * workspace is it?" step, so the one place a business could ever get a
 * `3-clients` and a `2-teams` folder was a step nobody on that route saw. For
 * a shared workspace with an empty bucket this card therefore offers the same
 * kinds (`../../workspace/presets`), one press each, and writes the one
 * chosen. A personal workspace keeps the standard five: the kinds are
 * shapes for a group, and a half-written layout is only ever finished with
 * the layout that started it.
 *
 * ## Custom folders are deliberately not here
 *
 * The flows offer "name your own folders" beside the standard layout, and this
 * does not. The standard layout is one press and is undoable by renaming; the
 * custom editor is a form with validation, its own refusals, and a decision to
 * make — a console notice band is the wrong frame for it, exactly as
 * `CreateWorkspaceScreen` says a modal is the wrong frame for a name claim. The
 * last line says the layout can be reorganised afterwards, including by asking
 * a connected client, which is the honest route to a custom shape from here.
 */
export function SetupPrompt({
  setup,
  workspaceId,
  shared = false,
  onImportVault,
}: {
  setup: ContextSetup;
  /** The context being set up. */
  workspaceId: string;
  /** A shared workspace: offer the kinds of workspace rather than PARA alone. */
  shared?: boolean;
  /** Opens Settings → Storage, where the importer lives. */
  onImportVault?: () => void;
}) {
  const applyStructure = useMutation(api.functions.workspaces.applyStructure);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [preset, setPreset] = useState<WorkspacePresetKey>(DEFAULT_PRESET);
  const choosing = offersKinds(setup, shared);

  const apply = useCallback(() => {
    setApplying(true);
    setFailure(undefined);
    const args = choosing
      ? toApplyStructureArgs(workspaceId, templateFor(preset), presetRows(preset))
      : { template: "para" as const };
    void applyStructure({ ...args, workspaceId: workspaceId as Id<"workspaces"> })
      .catch((error: unknown) => {
        /*
          Our sentence, never the backend's — a Convex error can carry a
          function path. The one refusal worth naming is the race this card
          cannot see: somebody laid the context out from another device while
          this was on screen, and the honest answer is that nothing is wrong.
        */
        const code = (error as { data?: { code?: string } })?.data?.code;
        setFailure(
          code === "STRUCTURE_ALREADY_APPLIED" || code === "CONTEXT_NOT_EMPTY"
            ? "This context already has a layout — nothing was changed. Reload to see it."
            : "That did not go through. Check your connection and try again.",
        );
      })
      .finally(() => setApplying(false));
  }, [applyStructure, choosing, preset, workspaceId]);

  return (
    <SetupPromptBody
      setup={setup}
      applying={applying}
      failure={failure}
      onApplyLayout={apply}
      onImportVault={onImportVault}
      kind={choosing ? { preset, onChoose: setPreset } : undefined}
      shared={shared}
    />
  );
}

/**
 * The kinds the card offers: every one that names its own folders, plus the
 * standard layout. "Something else" is the custom editor, which this card
 * deliberately does not carry (see the header).
 */
export const SETUP_KINDS = WORKSPACE_PRESETS.filter((entry) => entry.key !== "custom");

/**
 * Whether the card asks what kind of workspace this is.
 *
 * Only for a shared workspace with an empty bucket: an unfinished layout is
 * finished with the standard one (`../setup.ts` never offers to finish a
 * custom one), and a personal workspace is one person's, which is what PARA
 * is for.
 */
export function offersKinds(setup: ContextSetup, shared: boolean): boolean {
  return shared && setup.kind === "empty";
}

/** The folder lines the card lists for a choice: the preset's, or PARA's. */
function folderLinesFor(preset: WorkspacePresetKey | undefined): { folder: string; line: string }[] {
  if (preset === undefined || preset === "para") return paraFolderLines();
  return presetRows(preset).map((row) => ({ folder: row.name, line: row.description }));
}

/**
 * The card with its data already resolved — what the suite drives, exactly as
 * `StorageStepBody` and `StorageChoiceBody` are.
 */
export function SetupPromptBody({
  setup,
  applying,
  failure,
  onApplyLayout,
  onImportVault,
  kind,
  shared = false,
}: {
  setup: ContextSetup;
  applying: boolean;
  failure?: string;
  onApplyLayout: () => void;
  onImportVault?: () => void;
  /** Present when the card asks what kind of workspace this is. */
  kind?: { preset: WorkspacePresetKey; onChoose: (preset: WorkspacePresetKey) => void };
  /** A shared workspace, whose folders start open to its members. */
  shared?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const copy = setupCopy(setup, kind !== undefined);
  if (copy === null) return null;

  return (
    <Card style={styles.card} testID="console-setup-prompt">
      <Text variant="rowTitle" role="heading" aria-level={2}>
        {copy.title}
      </Text>
      <Text variant="rowSub" style={styles.body}>
        {copy.body}
      </Text>

      {/*
        The folders by name, because "the standard layout" is not a thing
        anybody can consent to. Five lines is cheap and it is the difference
        between a button somebody presses and one they leave alone.
      */}
      {kind === undefined ? null : (
        <ChoiceGroup<WorkspacePresetKey>
          label="Kind of workspace"
          options={SETUP_KINDS.map((entry) => ({
            value: entry.key,
            label: entry.key === DEFAULT_PRESET ? `${entry.label} (recommended)` : entry.label,
            detail: entry.summary,
          }))}
          value={kind.preset}
          onChange={kind.onChoose}
          disabled={applying}
          style={styles.kinds}
          testID="console-setup-kind"
        />
      )}

      <View style={styles.folders} testID="console-setup-folders">
        {folderLinesFor(kind?.preset).map(({ folder, line }) => (
          <View key={folder} style={styles.folderRow}>
            <Text variant="check" style={styles.folderName}>
              {folder}
            </Text>
            <Text variant="rowSub" style={styles.folderLine}>
              {line}
            </Text>
          </View>
        ))}
      </View>

      {failure === undefined ? null : <FormError headline={failure} style={styles.failure} />}

      <Row style={styles.actions}>
        {applying ? (
          <View style={styles.working} testID="console-setup-working">
            <ActivityIndicator size="small" />
            <Text variant="rowSub">
              {setup.kind === "unfinished" ? "Finishing your folders…" : "Creating your folders…"}
            </Text>
          </View>
        ) : (
          <Button
            label={setup.kind === "unfinished" ? "Finish these folders" : "Create these folders"}
            variant="decision"
            onPress={onApplyLayout}
            testID="console-setup-apply"
          />
        )}
        {onImportVault === undefined || applying ? null : (
          <TextLink
            label="Import an Obsidian vault"
            onPress={onImportVault}
            testID="console-setup-import"
          />
        )}
      </Row>

      <Text variant="foot" style={styles.foot}>
        {shared ? WORKSPACE_PRIVACY_NOTE : PRIVACY_DEFAULT_NOTE} {REVERSIBLE_NOTE}
      </Text>
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.x2 },
    body: { lineHeight: leading(12.5, 1.7) },
    kinds: { marginTop: space.x2 },
    folders: { marginTop: space.x2, gap: space.x2 },
    folderRow: { flexDirection: "row", gap: space.x3, flexWrap: "wrap" },
    folderName: { minWidth: 92 },
    folderLine: { flex: 1, minWidth: 0, color: colors.muted },
    actions: { marginTop: space.x3, gap: space.x3, flexWrap: "wrap" },
    working: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    failure: { marginTop: space.x2 },
    foot: { marginTop: space.x3, lineHeight: leading(12.5, 1.7), color: colors.muted },
  });
