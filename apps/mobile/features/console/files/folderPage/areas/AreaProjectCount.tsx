/**
 * An area's projects on the Areas List, where the verdict words used to be
 * (the owner, 2026-11-26: "instead of exceeds targets etc, just show x
 * projects", in "the green and yellow colors"): the Projects List's
 * half-filled circle, "7 projects", and a chevron, all in the area's verdict
 * colour, green when its number is on or past its target or on pace and
 * yellow when it is short or over a limit; muted with no verdict. A press
 * unfolds the projects in progress under the row, then one muted line for the
 * rest. The projects stay in the Projects folder; a row opens the project
 * there. Presentational only: `areaProjects.ts` says which projects serve the
 * area, `verdict.ts` how the number stands.
 */

import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { areasType, pointerType } from "../../../../design/tokens";
import { OwnerFace, StatusDot, type Face } from "../Glyphs";
import { restLine, servesWhere, type AreaProjects } from "./areaProjects";
import type { Verdict } from "./verdict";

/** The pointer state a web Pressable reports, which react-native-web adds to RN's. */
interface HoverState {
  readonly hovered?: boolean;
  readonly pressed: boolean;
}

function hoverTitle(text: string): { readonly title?: string } {
  return Platform.OS === "web" ? { title: text } : {};
}

/** "7 projects": what the count says on the row. */
export function projectsCount(count: number): string {
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

/** The ink of the count: the verdict's green or yellow, muted with none. */
export function countTone(verdict: Verdict | null): "good" | "bad" | "quiet" {
  if (verdict === null) return "quiet";
  return verdict.good ? "good" : "bad";
}

/** The half-filled circle in one ink, the Projects List's in-progress mark. */
function HalfCircle({ color }: { color: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.circle, { borderColor: color }]} aria-hidden>
      <View style={[styles.half, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * The count of an area's projects in progress, which shows them under its row;
 * nothing when there are none. The verdict's words ride along for a screen
 * reader and a hover, so the colour is never the only sign.
 */
export function ProjectsButton({ count, area, folder, verdict, open, phone, onPress }: { count: number; area: string; folder: string; verdict: Verdict | null; open: boolean; phone: boolean; onPress: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  if (count === 0) return null;
  const tone = countTone(verdict);
  const ink = tone === "good" ? colors.okText : tone === "bad" ? colors.warnText : colors.muted;
  const words = `${open ? "Hide" : "Show"} ${projectsCount(count)} in progress for ${area}${verdict === null ? "" : `; ${verdict.words}`}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={words}
      aria-expanded={open}
      hitSlop={4}
      style={({ hovered }: HoverState) => [phone ? styles.countPhone : styles.count, (hovered || open) && styles.countOn]}
      testID={`area-projects-${folder}`}
      {...({ dataSet: { tone } } as unknown as object)}
      {...hoverTitle(words)}
    >
      <HalfCircle color={ink} />
      <Text variant="treeMeta" style={[phone ? styles.countWordPhone : styles.countWord, { color: ink }]} numberOfLines={1}>
        {projectsCount(count)}
      </Text>
      <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
        <Svg width={10} height={10} viewBox="0 0 14 14" aria-hidden>
          <Path d="M5 3l4 4-4 4" fill="none" stroke={ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Pressable>
  );
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
    count: { flexDirection: "row", alignItems: "center", gap: 6, height: 26, paddingHorizontal: 8, borderRadius: 6, alignSelf: "flex-start", maxWidth: "100%" },
    countPhone: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 5, height: 28, minWidth: 44, paddingHorizontal: 8, borderRadius: 999, flexShrink: 0 },
    countOn: { backgroundColor: colors.chipFill },
    countWord: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "600", flexShrink: 1, minWidth: 0 },
    countWordPhone: { fontSize: pointerType.ui - 1, lineHeight: 18, fontWeight: "600" },
    circle: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, overflow: "hidden", flexShrink: 0, flexDirection: "row" },
    half: { width: "50%", height: "100%" },
    row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingRight: 12, borderRadius: 8 },
    rowPhone: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
    hover: { backgroundColor: colors.chipFill },
    glyph: { width: 16, alignItems: "center", flexShrink: 0 },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, lineHeight: 18, color: colors.text2 },
    namePhone: { fontSize: areasType.value, lineHeight: 20 },
    meta: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 0 },
    rest: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, paddingVertical: 4 },
  });
