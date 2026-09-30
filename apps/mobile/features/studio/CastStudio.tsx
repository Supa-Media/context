import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { castActors, setCastPace, splitWebsiteCast, type CastPaceName } from "@context/shared";
import type { PresenceMember } from "../console/presence/protocol";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { castTimeLabel } from "../home/cast/castTimeline";
import { castColors } from "../home/cast/castRun";
import { castPreviewFragment } from "../home/castPreview";
import { pagesByName, useScenePages, type ReadScenePage } from "./scenePages";
import { useSceneEmoji, type LoadEmoji } from "./sceneEmoji";
import { stripFrontmatter } from "../share/markdown";
import { STUDIO_FRAMES, studioFrame, type StudioFrameId } from "./studioFrames";
import { studioScript } from "./studioScript";
import { StudioRecord } from "./StudioRecord";
import { StudioSoundsPanel } from "./sounds/StudioSoundsPanel";
import { useStudioSounds, type SaveSounds, type SoundStorage } from "./sounds/useStudioSounds";
import { StudioScriptRail } from "./StudioScriptRail";
import { scriptEdits, type WriteScript } from "./scriptEdits";
import { useMovedStarts, useOutsideChanges } from "./scriptChanges";
import { StudioPace } from "./StudioPace";
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
  onSavePace,
  loadEmoji,
  onEditScript,
  members,
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
  /** Writes the scene's `pace:` line into the note; why not, or `null`. Absent where it cannot be changed. */
  onSavePace?: (pace: CastPaceName) => string | null;
  /** Reads a workspace emoji, so the stage draws `:name:` as the published page will. */
  loadEmoji?: LoadEmoji;
  /** Changes the note's script from the rail; absent where the note cannot be changed. */
  onEditScript?: WriteScript;
  /** Who is in the note now, to say who changed the script when the studio did not. */
  members?: readonly PresenceMember[];
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
  /*
    A pace just chosen shows at once, whether or not it could be kept; the
    note's own line takes over again as soon as it changes.
  */
  const [paceChoice, setPaceChoice] = useState<CastPaceName | null>(null);
  const scene = paceChoice === null ? draft : setCastPace(draft, paceChoice);
  const notePace = useMemo(() => splitWebsiteCast(stripFrontmatter(draft)).pace ?? "lively", [draft]);
  useEffect(() => setPaceChoice(null), [notePace]);
  const choosePace = (pace: CastPaceName) => {
    setPaceChoice(pace);
    onSavePace?.(pace);
    // The stage reads the scene when it loads: a fresh one, waiting for Play.
    player.hold();
  };
  const script = useMemo(() => studioScript(scene, pagesByName(pages)), [scene, pages]);
  // The text this studio last wrote: a draft equal to it is our own edit.
  const ours = useRef<string | null>(null);
  const write = useCallback<WriteScript>(
    (change) =>
      onEditScript === undefined
        ? null
        : onEditScript((current) => {
            const next = change(current);
            ours.current = next;
            return next;
          }),
    [onEditScript],
  );
  const edits = useMemo(() => (onEditScript === undefined ? undefined : scriptEdits(write)), [onEditScript, write]);
  const cast = useMemo(() => castActors(stripFrontmatter(draft)), [draft]);
  const outside = useOutsideChanges(draft, ours, members ?? []);
  const moved = useMovedStarts(draft, ours, script.rows);
  // After an edit here the stage is a fresh page of the new script, waiting for Play.
  useEffect(() => {
    if (ours.current !== null && draft === ours.current) player.hold();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per version of the note
  }, [draft]);
  const memberColors = useMemo(() => castColors(splitWebsiteCast(stripFrontmatter(draft)).steps), [draft]);
  const emoji = useSceneEmoji([scene, ...pages.map((page) => page.markdown)], loadEmoji);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new page is what reads a new draft
  const src = useMemo(() => `/#${castPreviewFragment(scene, title, pages, emoji)}`, [player.stageKey, title, pages, emoji]);
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
            <StudioPace pace={script.pace} onChange={choosePace} />
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
              cast={cast}
              edits={edits}
              change={outside}
              moved={moved}
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
