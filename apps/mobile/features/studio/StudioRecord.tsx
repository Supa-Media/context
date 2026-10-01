import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { captureTab, saveVideo, type TabRecording } from "./export/tabRecorder";
import { EXPORT_SIZES, canExportVideo, exportFileName } from "./export/videoExport";
import type { StudioFrame } from "./studioFrames";
import { StudioStage } from "./StudioStage";
import type { StudioPlayer } from "./useStudioPlayer";

/** The quiet before the show, once Start is pressed: time to settle the recorder. */
export const RECORD_COUNT_MS = 3_000;
/** How long the last frame holds before the Done card covers it. */
export const RECORD_HOLD_MS = 1_000;

type Phase = "prep" | "asking" | "count" | "rolling" | "saving" | "done";

/** The scene's sounds, for an export to put in the file (`useStudioSounds`). */
export interface RecordSound {
  capture: () => MediaStream | null;
  lag: (seconds: number) => void;
  release: () => void;
}

/**
 * Record: the stage alone, filling the window, for a screen recorder.
 *
 * First a card says what to do (start the recorder on this window, press
 * Start). Start takes the card away and holds the first frame for three
 * seconds with nothing on it, not even a number, since anything shown is in
 * the take. Then the scene plays with no controls and no pointer, holds its
 * last frame, and a card says to stop the recorder. Escape leaves at any time.
 *
 * Or Export video (`export/`): the browser asks once to share this tab, and
 * the same take is recorded here and saved as a file at the frame's delivery
 * size, with no recorder of anyone's own.
 */
export function StudioRecord({
  player,
  frame,
  src,
  sceneName,
  sound,
  onLeave,
}: {
  player: StudioPlayer;
  frame: StudioFrame;
  src: string;
  sceneName: string;
  sound?: RecordSound;
  onLeave: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>("prep");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const take = useRef<TabRecording | null>(null);
  const [exportable] = useState(() => Platform.OS === "web" && canExportVideo());
  const { hold, start, onEnded } = player;
  // Read when the take ends, so a render mid-take does not restart its timer.
  const about = useRef({ sceneName, frame, sound });
  about.current = { sceneName, frame, sound };

  // A fresh page that waits, so the take starts from the top.
  useEffect(() => {
    hold();
  }, [hold]);

  useEffect(() => {
    if (phase === "count") {
      const timer = setTimeout(() => {
        take.current?.begin();
        start();
        setPhase("rolling");
      }, RECORD_COUNT_MS);
      return () => clearTimeout(timer);
    }
    if (phase !== "rolling") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onEnded.current = () => {
      timer = setTimeout(() => {
        const recording = take.current;
        if (recording === null) return setPhase("done");
        take.current = null;
        setPhase("saving");
        void recording.finish().then((video) => {
          const { sceneName: scene, frame: shape, sound: sounds } = about.current;
          sounds?.release();
          const name = exportFileName(scene, shape.id, recording.type.extension);
          saveVideo(name, video);
          setSaved(name);
          setPhase("done");
        });
      }, RECORD_HOLD_MS);
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

  // Leaving mid-take shares nothing further and keeps nothing.
  const left = useRef(false);
  useEffect(
    () => () => {
      left.current = true;
      take.current?.cancel();
      take.current = null;
      sound?.release();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on leaving only
    [],
  );

  const again = () => {
    hold();
    setSaved(null);
    setPhase("prep");
  };

  // Called from the press itself: the browser asks only inside one.
  const exportVideo = () => {
    setProblem(null);
    setPhase("asking");
    void captureTab({
      stage: () => document.querySelector('[data-testid="studio-stage"]'),
      size: EXPORT_SIZES[frame.id],
      sound: sound?.capture() ?? null,
      lagSound: (seconds) => sound?.lag(seconds),
      onStopped: () => {
        take.current = null;
        sound?.release();
        hold();
        setProblem("Sharing stopped before the scene ended, so nothing was saved.");
        setPhase("prep");
      },
    }).then((captured) => {
      // Left while the browser was asking: share nothing.
      if (left.current) {
        if (!("problem" in captured)) captured.cancel();
        return;
      }
      if ("problem" in captured) {
        sound?.release();
        setProblem(captured.problem);
        setPhase("prep");
        return;
      }
      take.current = captured;
      setPhase("count");
    });
  };

  return (
    <View style={[styles.ground, phase === "count" || phase === "rolling" || phase === "saving" ? styles.bare : null]} testID="studio-record">
      <StudioStage key={player.stageKey} frame={frame} src={src} attach={player.attach} bare={phase === "count" || phase === "rolling" || phase === "saving"} />
      {phase === "prep" ? (
        <View style={styles.cover}>
          <View style={styles.card} accessibilityRole="none" aria-label="Ready to record">
            <Text variant="paneTitle">Ready to record</Text>
            <Text variant="rowSub" style={styles.muted}>
              {`${sceneName} · ${frame.label} · record at ${frame.video}`}
            </Text>
            {exportable ? (
              <View style={styles.steps}>
                <Text variant="body">
                  Export video plays the scene and saves it as a file, sounds and all. The browser asks once to share this
                  tab: choose it.
                </Text>
                <Text variant="rowSub" style={styles.muted}>
                  Using your own screen recorder instead? Start it on this window, then press Start.
                </Text>
              </View>
            ) : (
              <View style={styles.steps}>
                <Text variant="body">1. Start your screen recorder and choose this window.</Text>
                <Text variant="body">2. Press Start. After three quiet seconds the scene plays with nothing else on screen.</Text>
                <Text variant="body">3. When it ends, stop your recorder.</Text>
              </View>
            )}
            {problem !== null ? (
              <Text variant="rowSub" style={styles.problem} role="alert" testID="studio-record-problem">
                {problem}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button label="Cancel" variant="dialog" onPress={onLeave} />
              <Button
                label="Start"
                variant={exportable ? "dialog" : "dialogPrimary"}
                disabled={player.status !== "ready"}
                onPress={() => setPhase("count")}
                testID="studio-record-start"
              />
              {exportable ? (
                <Button
                  label="Export video"
                  variant="dialogPrimary"
                  disabled={player.status !== "ready"}
                  onPress={exportVideo}
                  testID="studio-record-export"
                />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
      {phase === "asking" ? (
        <View style={styles.cover}>
          <View style={styles.card}>
            <Text variant="paneTitle">Choose this tab</Text>
            <Text variant="body">When the browser asks what to share, pick this tab and press Share.</Text>
          </View>
        </View>
      ) : null}
      {phase === "done" ? (
        <View style={styles.cover}>
          <View style={styles.card} testID="studio-record-done">
            <Text variant="paneTitle">{saved === null ? "Done. Stop your recorder." : "Saved"}</Text>
            {saved !== null ? (
              <Text variant="rowSub" style={styles.muted}>
                {`${saved} is in your downloads.`}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button label="Back to studio" variant="dialog" onPress={onLeave} />
              <Button label={saved === null ? "Record again" : "Export again"} variant="dialogPrimary" onPress={again} />
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
    problem: { color: colors.crit },
    steps: { gap: space.x2 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
  });
