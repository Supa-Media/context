/**
 * The small marks a project row is read by: its priority, whose it is, and —
 * on a subtask — how far along it is.
 *
 * - **Priority** leads the row. Urgent is a small solid square in the ink
 *   colour with "!"; High, Medium and Low are three signal bars with three,
 *   two and one lit; no priority is a faint dash. No hue at all: red means
 *   failure in this palette, and a list of red squares reads as a list of
 *   errors. Each carries its word for a screen reader.
 * - **A face** is a person's round face (`PersonFace`: their photo or
 *   workspace icon, else a silhouette, never initials), or an AI
 *   helper's rounded square with a robot — never "AI" in letters, which
 *   reads as somebody's initials. A bot whose card names its logo
 *   (`avatar:`) is that logo instead, the face it has in its own app (the
 *   owner, 2026-11-25); the robot shows until it loads, and if it can't.
 *   Nobody is a dashed "?".
 * - **A subtask's dot** is its status group: an empty ring for Not started,
 *   half filled for In progress, full for Done.
 */

import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { StatusTone } from "./StatusPill";
import { toneColor } from "./StatusPill";
import { priorityWord, type Priority } from "./taskProps";
import { PersonFace } from "../../faces/PersonFace";

const GLYPH = 16;

export function PriorityGlyph({ priority }: { priority: Priority | null }) {
  const styles = useThemedStyles(makeStyles);
  const label = priorityWord(priority);
  if (priority === 0) {
    return (
      <View style={styles.urgent} accessibilityLabel={label} testID="priority-urgent">
        <Text variant="badge" style={styles.urgentMark} aria-hidden>
          !
        </Text>
      </View>
    );
  }
  if (priority === null) {
    return (
      <View style={styles.box} accessibilityLabel={label} testID="priority-none">
        <View style={styles.dash} />
      </View>
    );
  }
  const lit = 4 - priority;
  return (
    <View style={styles.bars} accessibilityLabel={label} testID={`priority-bars-${lit}`}>
      {[5, 9, 13].map((height, at) => (
        <View key={height} style={[styles.bar, { height }, at < lit && styles.barLit]} />
      ))}
    </View>
  );
}

/** A bot's logo: `key` names the bytes (the stored picture's name is a hash of them), `read` fetches them as a `src`. */
export interface FacePicture {
  readonly key: string;
  readonly read: () => Promise<string | null>;
}

export type Face =
  | { readonly kind: "person"; readonly name: string }
  | { readonly kind: "agent"; readonly picture?: FacePicture }
  | { readonly kind: "nobody" };

/** Read once a session for every face drawing it: the key is the bytes' own hash, so it never goes stale. */
const pictures = new Map<string, Promise<string | null>>();

function usePicture(picture: FacePicture | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = picture?.key ?? null;
  useEffect(() => {
    setSrc(null);
    if (picture === undefined) return;
    let live = true;
    let found = pictures.get(picture.key);
    if (found === undefined) {
      found = picture.read().catch(() => null);
      pictures.set(picture.key, found);
      // A failed read is asked again next time, not remembered as missing.
      void found.then((read) => read === null && pictures.delete(picture.key));
    }
    void found.then((read) => live && setSrc(read));
    return () => {
      live = false;
    };
    // `key` stands for `picture`, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return src;
}

export function OwnerFace({ face, size = 24 }: { face: Face; size?: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const logo = usePicture(face.kind === "agent" ? face.picture : undefined);
  const box = { width: size, height: size };
  if (face.kind === "nobody") {
    return (
      <View style={[styles.face, styles.nobody, box]} testID="owner-face-nobody" aria-hidden>
        <Text variant="badge" style={styles.nobodyMark}>
          ?
        </Text>
      </View>
    );
  }
  if (face.kind === "agent" && logo !== null) {
    return <Image source={{ uri: logo }} style={[styles.face, styles.logo, box]} testID="owner-face-logo" aria-hidden />;
  }
  if (face.kind === "agent") {
    return (
      <View style={[styles.face, styles.agent, box]} testID="owner-face-agent" aria-hidden>
        <Icon name="robot" size={Math.round(size * 0.62)} color={colors.text2} />
      </View>
    );
  }
  return <PersonFace name={face.name} size={size} style={styles.person} testID="owner-face-person" />;
}

export function StatusDot({ tone }: { tone: StatusTone }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const color = toneColor(colors, tone);
  return (
    <View style={[styles.dot, { borderColor: color }, tone === "done" && { backgroundColor: color }]} aria-hidden testID={`status-dot-${tone}`}>
      {tone === "in-progress" ? <View style={[styles.half, { backgroundColor: color }]} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { width: GLYPH, height: GLYPH, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    urgent: {
      width: GLYPH,
      height: GLYPH,
      borderRadius: 4,
      backgroundColor: colors.text,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    urgentMark: { color: colors.ground, fontWeight: "700", lineHeight: GLYPH },
    dash: { width: 8, height: 1.5, borderRadius: 1, backgroundColor: colors.chromeMuted, opacity: 0.6 },
    bars: { width: GLYPH, height: 13, flexDirection: "row", alignItems: "flex-end", gap: 2, flexShrink: 0 },
    bar: { width: 3, borderRadius: 1, backgroundColor: colors.lineStrong },
    barLit: { backgroundColor: colors.text2 },
    face: { alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" },
    person: { borderRadius: radii.pill, backgroundColor: colors.surface3 },
    agent: { borderRadius: 7, backgroundColor: colors.chipFill, borderWidth: 1, borderColor: colors.line },
    logo: { borderRadius: 7 },
    nobody: { borderRadius: radii.pill, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong },
    nobodyMark: { color: colors.chromeMuted },
    dot: { width: 15, height: 15, borderRadius: radii.pill, borderWidth: 1.5, overflow: "hidden", flexShrink: 0 },
    half: { position: "absolute", left: 0, top: 0, bottom: 0, width: "50%" },
  });
