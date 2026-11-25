/**
 * An area's projects on the Areas List: the count of those in progress at the
 * end of its row, drawn with the Projects List's own half-filled circle, and
 * the rows it unfolds under the area, as the owner approved on 2026-11-25 (the
 * "Projects in areas" boards). The projects stay in the Projects folder; a
 * row opens the project there. Presentational only: `areaProjects.ts` says
 * which projects serve the area.
 */

import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { areasType, pointerType } from "../../../../design/tokens";
import { OwnerFace, StatusDot, type Face } from "../Glyphs";
import { areaKey, restLine, type AreaProject, type AreaProjects } from "./areaProjects";

/** The pointer state a web Pressable reports, which react-native-web adds to RN's. */
interface HoverState {
  readonly hovered?: boolean;
  readonly pressed: boolean;
}

function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" ? { title: text } : {};
}

/** "2 projects in progress": the count's words, for a screen reader and a hover. */
export function projectsWords(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"} in progress`;
}

/** The count of an area's projects in progress, which shows them under its row; nothing when there are none. */
export function ProjectsButton({ count, area, folder, open, phone, onPress }: { count: number; area: string; folder: string; open: boolean; phone: boolean; onPress: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  if (count === 0) return null;
  const words = `${open ? "Hide" : "Show"} ${projectsWords(count)} for ${area}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={words}
      aria-expanded={open}
      hitSlop={4}
      style={({ hovered }: HoverState) => [phone ? styles.countPhone : styles.count, (hovered || open) && styles.countOn]}
      testID={`area-projects-${folder}`}
      {...hoverTitle(words)}
    >
      <StatusDot tone="in-progress" />
      <Text variant="treeMeta" style={phone ? styles.countWordPhone : styles.countWord}>
        {String(count)}
      </Text>
      <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        <Svg width={10} height={10} viewBox="0 0 14 14" aria-hidden>
          <Path d="M5 3l4 4-4 4" fill="none" stroke={colors.muted} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Pressable>
  );
}

/** Where a project sits under the area it is counted for: "" when it is this area's own, else the sub-area's last folder. */
export function servesWhere(area: string, project: AreaProject): string {
  if (project.area === null || areaKey(project.area) === areaKey(area)) return "";
  const said = project.area.replace(/\/+$/, "");
  return said.slice(said.lastIndexOf("/") + 1);
}

/** The projects in progress under an area's row, then one muted line for the rest. */
export function ProjectRows({ area, projects, inset, phone, faceOf, onOpen }: { area: string; projects: AreaProjects; inset: number; phone: boolean; faceOf: (owner: string | null) => Face; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const rest = restLine(projects);
  return (
    <>
      {projects.inProgress.map((project) => {
        const where = servesWhere(area, project);
        return (
          <Pressable
            key={project.folder}
            onPress={() => onOpen(project.folder)}
            accessibilityLabel={`${project.name}, project in progress`}
            testID={`area-project-${project.folder}`}
            style={({ hovered }: HoverState) => [phone ? styles.rowPhone : styles.row, { paddingLeft: inset }, hovered && styles.hover]}
          >
            <View style={styles.glyph}>
              <StatusDot tone="in-progress" />
            </View>
            <Text variant="tree" style={[styles.name, phone && styles.namePhone]} numberOfLines={1}>
              {project.name}
            </Text>
            {where === "" ? null : (
              <Text variant="treeMeta" style={styles.meta} numberOfLines={1}>
                {where}
              </Text>
            )}
            {project.owner === null ? null : <OwnerFace face={faceOf(project.owner)} size={16} />}
          </Pressable>
        );
      })}
      {rest === "" ? null : (
        <Text variant="treeMeta" style={[styles.rest, { paddingLeft: inset + 24 }]} testID={`area-projects-rest-${area}`}>
          {rest}
        </Text>
      )}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    count: { flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 8, borderRadius: 6 },
    countPhone: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, height: 28, minWidth: 44, paddingHorizontal: 10, borderRadius: 999, flexShrink: 0 },
    countOn: { backgroundColor: colors.chipFill },
    countWord: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "500", color: colors.muted },
    countWordPhone: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "500", color: colors.muted },
    row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingRight: 12, borderRadius: 8 },
    rowPhone: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
    hover: { backgroundColor: colors.chipFill },
    glyph: { width: 16, alignItems: "center", flexShrink: 0 },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, color: colors.text2 },
    namePhone: { fontSize: areasType.value, lineHeight: 20 },
    meta: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 0 },
    rest: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, paddingVertical: 4 },
  });
