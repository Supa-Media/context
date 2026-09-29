import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { StudioFrame } from "./studioFrames";
import { StudioStage } from "./StudioStage";
import type { StudioPlayer } from "./useStudioPlayer";

/** The quiet before the show, once Start is pressed: time to settle the recorder. */
export const RECORD_COUNT_MS = 3_000;
/** How long the last frame holds before the Done card covers it. */
export const RECORD_HOLD_MS = 1_000;

type Phase = "prep" | "count" | "rolling" | "done";

/**
 * Record: the stage alone, filling the window, for a screen recorder.
 *
 * First a card says what to do (start the recorder on this window, press
 * Start). Start takes the card away and holds the first frame for three
 * seconds with nothing on it, not even a number, since anything shown is in
 * the take. Then the scene plays with no controls and no pointer, holds its
 * last frame, and a card says to stop the recorder. Escape leaves at any time.
 */
export function StudioRecord({
  player,
  frame,
  src,
  sceneName,
  onLeave,
}: {
  player: StudioPlayer;
  frame: StudioFrame;
  src: string;
  sceneName: string;
  onLeave: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>("prep");
  const { hold, start, onEnded } = player;

  // A fresh page that waits, so the take starts from the top.
  useEffect(() => {
    hold();
  }, [hold]);

  useEffect(() => {
    if (phase === "count") {
      const timer = setTimeout(() => {
        start();
        setPhase("rolling");
      }, RECORD_COUNT_MS);
      return () => clearTimeout(timer);
    }
    if (phase !== "rolling") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onEnded.current = () => {
      timer = setTimeout(() => setPhase("done"), RECORD_HOLD_MS);
    };
    return () => {
      onEnded.current = null;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [phase, start, onEnded]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onLeave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLeave]);

  const again = () => {
    hold();
    setPhase("prep");
  };

  return (
    <View style={[styles.ground, phase === "count" || phase === "rolling" ? styles.bare : null]} testID="studio-record">
      <StudioStage key={player.stageKey} frame={frame} src={src} attach={player.attach} bare={phase !== "prep" && phase !== "done"} />
      {phase === "prep" ? (
        <View style={styles.cover}>
          <View style={styles.card} accessibilityRole="none" aria-label="Ready to record">
            <Text variant="paneTitle">Ready to record</Text>
            <Text variant="rowSub" style={styles.muted}>
              {`${sceneName} · ${frame.label} · record at ${frame.video}`}
            </Text>
            <View style={styles.steps}>
              <Text variant="body">1. Start your screen recorder and choose this window.</Text>
              <Text variant="body">2. Press Start. After three quiet seconds the scene plays with nothing else on screen.</Text>
              <Text variant="body">3. When it ends, stop your recorder.</Text>
            </View>
            <View style={styles.actions}>
              <Button label="Cancel" variant="dialog" onPress={onLeave} />
              <Button
                label="Start"
                variant="dialogPrimary"
                disabled={player.status !== "ready"}
                onPress={() => setPhase("count")}
                testID="studio-record-start"
              />
            </View>
          </View>
        </View>
      ) : null}
      {phase === "done" ? (
        <View style={styles.cover}>
          <View style={styles.card}>
            <Text variant="paneTitle">Done. Stop your recorder.</Text>
            <View style={styles.actions}>
              <Button label="Back to studio" variant="dialog" onPress={onLeave} />
              <Button label="Record again" variant="dialogPrimary" onPress={again} />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.ground },
    bare: { cursor: "none" } as never,
    cover: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
    card: {
      width: 460,
      maxWidth: "92%",
      gap: space.x4,
      padding: space.x7,
      borderRadius: radii.sheet,
      backgroundColor: colors.pageSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    muted: { color: colors.muted },
    steps: { gap: space.x2 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
  });
