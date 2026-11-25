/**
 * The area panel's Projects section (the owner approved, 2026-11-25, the
 * "Projects in areas" boards): the projects in progress for the area and its
 * sub-areas, one line for the rest that unfolds them, and "Attach a project",
 * which picks from the Projects folder and writes the project's `area:` line.
 * A project row's × detaches it, which removes that line and nothing else.
 * One project serves one area, so attaching one that serves another moves it.
 * A reader sees the list with neither.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { OwnerFace, StatusDot, type Face } from "../Glyphs";
import type { StatusTone } from "../StatusPill";
import { servesWhere } from "./AreaProjectRows";
import { restLine, type AreaProject, type AreaProjects } from "./areaProjects";

export interface PanelProjectsTools {
  readonly projects: AreaProjects;
  readonly choices: readonly AreaProject[];
  readonly faceOf: (owner: string | null) => Face;
  readonly open: (folder: string) => void;
  /** Absent for a reader. */
  readonly attach?: (project: AreaProject, area: string | null) => Promise<string | null>;
}

interface HoverState {
  readonly hovered?: boolean;
  readonly pressed: boolean;
}

/** Choices shown before the filter is needed. */
const SHOWN = 8;

const toneOf = (project: AreaProject): StatusTone => project.group ?? "unplaced";

export function PanelProjects({ area, tools, onProblem }: { area: string; tools: PanelProjectsTools; onProblem: (problem: string | null) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const { projects, attach } = tools;
  const [restOpen, setRestOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const rest = restLine(projects);
  const others = [...projects.notStarted, ...projects.other, ...projects.done];
  const shown = restOpen ? [...projects.inProgress, ...others] : projects.inProgress;
  const write = async (project: AreaProject, to: string | null) => {
    if (attach === undefined) return;
    onProblem(await attach(project, to));
  };
  const words = filter.trim().toLowerCase();
  const choices = tools.choices.filter((project) => words === "" || project.name.toLowerCase().includes(words) || project.folder.toLowerCase().includes(words));
  return (
    <View style={styles.list} testID="area-panel-projects">
      {shown.length === 0 && rest === "" ? (
        <Text variant="treeMeta" style={styles.muted}>No projects yet.</Text>
      ) : null}
      {shown.map((project) => {
        const where = servesWhere(area, project);
        return (
          <Pressable
            key={project.folder}
            onPress={() => tools.open(project.folder)}
            accessibilityLabel={`Open ${project.name}`}
            style={({ hovered }: HoverState) => [styles.row, hovered && styles.hover]}
            testID={`area-panel-project-${project.folder}`}
          >
            {({ hovered }: HoverState) => (
              <>
                <StatusDot tone={toneOf(project)} />
                <Text variant="tree" style={styles.name} numberOfLines={1}>
                  {project.name}
                </Text>
                {where === "" ? null : (
                  <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
                    {where}
                  </Text>
                )}
                {project.owner === null ? null : <OwnerFace face={tools.faceOf(project.owner)} size={16} />}
                {attach === undefined ? null : (
                  <Pressable
                    onPress={() => void write(project, null)}
                    accessibilityLabel={`Detach ${project.name} from this area`}
                    hitSlop={6}
                    style={[styles.detach, { opacity: hovered || Platform.OS !== "web" ? 1 : 0 }]}
                    testID={`area-panel-detach-${project.folder}`}
                  >
                    <Icon name="close" size={11} color={colors.muted} />
                  </Pressable>
                )}
              </>
            )}
          </Pressable>
        );
      })}
      {rest === "" ? null : (
        <Pressable onPress={() => setRestOpen((open) => !open)} role="button" aria-expanded={restOpen} style={styles.rest} testID="area-panel-projects-rest">
          <Text variant="treeMeta" style={styles.muted}>
            {restOpen ? "Show only in progress" : `${rest} ›`}
          </Text>
        </Pressable>
      )}
      {attach === undefined ? null : picking ? (
        <View style={styles.pop} testID="area-panel-attach-list">
          {tools.choices.length > SHOWN ? (
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder="Find a project"
              placeholderTextColor={colors.muted}
              style={[styles.input, fieldFont]}
              autoFocus
              testID="area-panel-attach-filter"
            />
          ) : null}
          {choices.length === 0 ? (
            <Text variant="treeMeta" style={[styles.muted, styles.choice]}>
              {tools.choices.length === 0 ? "Every project is here already." : "No project by that name."}
            </Text>
          ) : null}
          {choices.slice(0, SHOWN).map((project) => (
            <Pressable
              key={project.folder}
              onPress={() => {
                setPicking(false);
                setFilter("");
                void write(project, area);
              }}
              style={({ hovered }: HoverState) => [styles.choice, hovered && styles.hover]}
              accessibilityLabel={`Attach ${project.name}`}
              testID={`area-panel-attach-${project.folder}`}
            >
              <Text variant="tree" style={styles.name} numberOfLines={1}>
                {project.name}
              </Text>
              <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
                {project.area === null ? "No area" : project.area.slice(project.area.lastIndexOf("/") + 1)}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setPicking(false)} style={styles.choice} accessibilityLabel="Cancel">
            <Text variant="treeMeta" style={styles.muted}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={() => setPicking(true)} role="button" style={styles.add} testID="area-panel-attach">
          <Text variant="treeMeta" style={styles.addWord}>+ Attach a project</Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: 2 },
    muted: { color: colors.muted, flexShrink: 0 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 30, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    hover: { backgroundColor: colors.chipFill },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    detach: { width: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
    rest: { alignSelf: "flex-start", paddingVertical: space.x1 },
    add: { alignSelf: "flex-start", paddingVertical: space.x1 },
    addWord: { color: colors.accentText, fontWeight: "600" },
    pop: { marginTop: space.x1, padding: space.x1, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.sm, backgroundColor: colors.surface2, gap: 1 },
    choice: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 28, paddingHorizontal: space.x2, borderRadius: radii.sm },
    input: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text, height: 28, paddingHorizontal: 8, marginBottom: 2, borderWidth: 1, borderColor: colors.line, borderRadius: radii.sm },
  });
