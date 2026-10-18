/**
 * The AI tab's one picker on a phone (board 22): the rail folds into a single
 * "Tex, by text ▾" button, so a job page shows one row of tabs, its own,
 * rather than the rail's chips above the job's. The menu lists every part of
 * the rail with the jobs by name, where the rail would make two steps of it.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Menu } from "../design/components/Menu";
import type { MenuItem } from "../console/files/menuItem";
import type { AiJob } from "./aiCatalog";
import type { AiPlace, AiViewKey } from "./aiPlace";

type PickId = `view:${AiViewKey}` | `job:${string}`;

/** What the button says: the job open, else the part of the rail. */
export function pickedLabel(place: AiPlace, jobs: readonly AiJob[], rail: readonly { key: string; label: string }[]): string {
  if (place.view === "jobs" && place.job !== null) return jobs.find((job) => job.key === place.job)?.label ?? place.job;
  if (place.view === "files") return "Files: the ai/ folder";
  return rail.find((item) => item.key === place.view)?.label ?? "Overview";
}

export function pickerMenu(place: AiPlace, jobs: readonly AiJob[], rail: readonly { key: string; label: string }[], counts: Record<string, number | null>): MenuItem<PickId>[] {
  const openJob = place.view === "jobs" ? place.job : null;
  const items: MenuItem<PickId>[] = [];
  for (const item of rail) {
    const count = counts[item.key] ?? null;
    items.push({
      id: `view:${item.key as AiViewKey}`,
      label: item.key === "jobs" ? "All jobs" : item.label,
      value: count === null ? undefined : String(count),
      checked: place.view === item.key && openJob === null,
      separatorBefore: item.key === "helpers",
    });
    if (item.key === "jobs") {
      jobs.forEach((job, index) => items.push({ id: `job:${job.key}`, label: job.label, checked: openJob === job.key, separatorBefore: index === 0 }));
    }
  }
  items.push({ id: "view:files", label: "Files: the ai/ folder", checked: place.view === "files", separatorBefore: true });
  return items;
}

export function AiPhonePicker({ place, jobs, rail, counts, onView, onJob }: {
  place: AiPlace;
  jobs: readonly AiJob[];
  rail: readonly { key: string; label: string }[];
  counts: Record<string, number | null>;
  onView: (key: AiViewKey) => void;
  onJob: (key: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const button = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const label = pickedLabel(place, jobs, rail);
  const open = () => {
    button.current?.measureInWindow((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
    setMenu((was) => was ?? { x: 0, y: 0 });
  };
  const pick = (id: PickId) => {
    setMenu(null);
    if (id.startsWith("job:")) onJob(id.slice(4));
    else onView(id.slice(5) as AiViewKey);
  };
  return (
    <View>
      <Pressable ref={button} role="button" accessibilityLabel={`AI: ${label}. Change`} onPress={open} style={styles.button} testID="admin-ai-picker">
        <Text variant="rowTitle" numberOfLines={1} style={styles.label}>{label}</Text>
        <Text variant="meta" style={styles.caret}>▾</Text>
      </Pressable>
      {menu !== null ? <Menu<PickId> items={pickerMenu(place, jobs, rail, counts)} anchor={menu} title="AI" onSelect={pick} onDismiss={() => setMenu(null)} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    button: { flexDirection: "row", alignItems: "center", gap: space.x2, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x3, paddingVertical: space.x2, minWidth: 0 },
    label: { flex: 1, minWidth: 0, color: colors.text },
    caret: { color: colors.muted },
  });
