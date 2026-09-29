import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { splitWebsiteCast } from "@context/shared";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { castTimeLabel } from "../home/cast/castTimeline";
import { castColors } from "../home/cast/castRun";
import { castPreviewFragment } from "../home/castPreview";
import { pagesByName, useScenePages, type ReadScenePage } from "./scenePages";
import { stripFrontmatter } from "../share/markdown";
import { STUDIO_FRAMES, studioFrame, type StudioFrameId } from "./studioFrames";
import { studioScript } from "./studioScript";
import { StudioRecord } from "./StudioRecord";
import { StudioSoundsPanel } from "./sounds/StudioSoundsPanel";
import { useStudioSounds, type SaveSounds, type SoundStorage } from "./sounds/useStudioSounds";
import { StudioScriptRail } from "./StudioScriptRail";
import { StudioStage } from "./StudioStage";
import { StudioTransport } from "./StudioTransport";
import { useStudioPlayer } from "./useStudioPlayer";

/** Below this width the script rail steps aside and the stage has the window. */
const RAIL_MIN_WINDOW = 900;

/**
 * The cast studio: a note's cast played as a scene, to be screen recorded.
 *
 * Opened by "Preview demo" on a note with a cast, over the console, and
 * closed back to the note. The scene plays on a stage (`StudioStage`), which
 * is the homepage playing the draft, exactly as "Preview demo" always has: the
 * console's editor is bound to the real note and a cast types into whatever it
 * is bound to, so nothing here plays in the editor. The stage is a fresh page
 * whenever it starts over, drawn from the draft as it is at that moment, so an
 * edit to the script shows on the next play.
 *
 * Sounds play here, in the studio, at the moments the stage reports; the page
 * on the stage makes none, so the homepage itself stays silent.
 *
 * Designed on the cast studio artboard, which Dev2 approved on 2026-09-29.
 */
export function CastStudio({
  draft,
  title,
  onClose,
  onSaveSounds,
  soundStorage,
  readPage,
}: {
  draft: string;
  title: string;
  onClose: () => void;
  /** Keeps sound choices in the note; absent where the note cannot be changed. */
  onSaveSounds?: SaveSounds;
  /** Where uploaded sounds are kept and read back: the workspace's asset store. */
  soundStorage?: SoundStorage;
  /** Reads a page the scene opens (`opens: pricing`), for the stage to go to. */
  readPage?: ReadScenePage;
}) {
  const styles = useThemedStyles(makeStyles);
  const wide = useWindowDimensions().width >= RAIL_MIN_WINDOW;
  const [frameId, setFrameId] = useState<StudioFrameId>("desktop");
  const [recording, setRecording] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const player = useStudioPlayer();
  const sounds = useStudioSounds(draft, player, onSaveSounds, soundStorage);
  const frame = studioFrame(frameId);

  // The draft as it is each time the stage loads; the rail follows every edit.
  const pages = useScenePages(draft, readPage);
  const script = useMemo(() => studioScript(draft, pagesByName(pages)), [draft, pages]);
  const memberColors = useMemo(() => castColors(splitWebsiteCast(stripFrontmatter(draft)).steps), [draft]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new page is what reads a new draft
  const src = useMemo(() => `/#${castPreviewFragment(draft, title, pages)}`, [player.stageKey, title, pages]);
  const total = script.timeline.total;

  return (
    <Modal visible animationType="none" onRequestClose={recording ? () => setRecording(false) : onClose}>
      <View style={styles.ground} testID="cast-studio">
        <View style={styles.top}>
          <View style={styles.topSide}>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.back} testID="studio-back">
              <Icon name="chevronLeft" size={16} />
              <Text variant="rowSub" style={styles.muted}>
                Back to note
              </Text>
            </Pressable>
            <View style={styles.titleBox}>
              <Text variant="rowTitle" numberOfLines={1}>
                {title}
              </Text>
              <Text variant="rowSub" style={styles.muted}>
                {`${script.rows.length} ${script.rows.length === 1 ? "step" : "steps"} · ${castTimeLabel(total)}`}
              </Text>
            </View>
          </View>
          <View style={styles.frames} accessibilityRole="radiogroup" aria-label="Frame">
            {STUDIO_FRAMES.map((one) => {
              const on = one.id === frameId;
              return (
                <Pressable
                  key={one.id}
                  onPress={() => setFrameId(one.id)}
                  accessibilityRole="radio"
                  aria-checked={on}
                  style={[styles.frameButton, on ? styles.frameOn : null]}
                  testID={`studio-frame-${one.id}`}
                >
                  <View style={[styles.frameGlyph, { aspectRatio: one.width / one.height }, on ? styles.frameGlyphOn : null]} />
                  <Text variant="rowSub" style={on ? styles.frameTextOn : styles.muted}>
                    {one.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={[styles.topSide, styles.topEnd]}>
            <Pressable
              onPress={() => setSoundsOpen((open) => !open)}
              accessibilityRole="button"
              aria-pressed={soundsOpen}
              style={[styles.frameButton, styles.soundsButton, soundsOpen ? styles.frameOn : null]}
              testID="studio-sounds-toggle"
            >
              <Icon name="speaker" size={16} />
              <Text variant="rowSub" style={soundsOpen ? styles.frameTextOn : styles.muted}>
                Sounds
              </Text>
            </Pressable>
            <Button
              label="Record"
              variant="accent"
              onPress={() => setRecording(true)}
              leading={<View style={styles.recordDot} />}
              testID="studio-record"
            />
          </View>
        </View>

        <View style={styles.body}>
          {wide ? (
            <StudioScriptRail
              rows={script.rows}
              current={player.current}
              colors={memberColors}
              problems={script.problems}
              onJump={player.jump}
            />
          ) : null}
          <View style={styles.main}>
            {recording ? null : (
              <StudioStage key={player.stageKey} frame={frame} src={src} attach={player.attach} />
            )}
            {recording ? null : <StudioTransport player={player} rows={script.rows} total={total} />}
          </View>
          {soundsOpen && !recording ? <StudioSoundsPanel sounds={sounds} counts={script.timeline.moments} /> : null}
        </View>

        {recording ? (
          <StudioRecord
            player={player}
            frame={frame}
            src={src}
            sceneName={title}
            onLeave={() => {
              setRecording(false);
              player.hold();
            }}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    top: {
      height: 60,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.x4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
      backgroundColor: colors.chromeSurface,
    },
    topSide: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x4, minWidth: 0 },
    topEnd: { justifyContent: "flex-end", gap: space.x2 },
    back: { flexDirection: "row", alignItems: "center", gap: space.x1, minHeight: 44, paddingRight: space.x2 },
    titleBox: { minWidth: 0, flexShrink: 1 },
    muted: { color: colors.muted },
    frames: { flexDirection: "row", gap: 2, padding: 3, borderRadius: radii.xl, backgroundColor: colors.chipFill },
    frameButton: { flexDirection: "row", alignItems: "center", gap: space.x2, height: 38, paddingHorizontal: space.x3, borderRadius: radii.lg },
    soundsButton: { backgroundColor: colors.chipFill },
    frameOn: { backgroundColor: colors.rowSelected },
    frameGlyph: { height: 14, maxWidth: 20, borderWidth: 1.4, borderColor: colors.muted, borderRadius: 2 },
    frameGlyphOn: { borderColor: colors.text },
    frameTextOn: { color: colors.text, fontWeight: "600" },
    recordDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.crit },
    body: { flex: 1, flexDirection: "row", minHeight: 0 },
    main: { flex: 1, minWidth: 0, paddingTop: space.x5, paddingHorizontal: space.x5, backgroundColor: colors.chromeSurface },
  });
