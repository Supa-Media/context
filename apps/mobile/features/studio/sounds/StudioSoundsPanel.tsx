import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Switch } from "../../design/components/Switch";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { CAST_MOMENTS, type CastMoment } from "../../home/cast/castRun";
import { MOMENT_LABELS, MOMENT_SOUNDS, isUploadedSound, momentCount, soundLabel, type SoundPlan } from "./castSounds";
import type { StudioSounds } from "./useStudioSounds";

const VOLUME_STEP = 10;

/**
 * "Sounds in this scene", drawn from the studio artboard's Sounds screen: one
 * row a moment, with how often it happens in this scene and the sound it
 * makes; open a row to pick another sound, hear each one, or change its
 * volume, or upload a sound of your own. One switch mutes the scene.
 */
export function StudioSoundsPanel({ sounds, counts }: { sounds: StudioSounds; counts: Record<CastMoment, number> }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState<CastMoment | null>(null);
  const { plan, change } = sounds;

  const choose = (moment: CastMoment, patch: Partial<SoundPlan["moments"][CastMoment]>) =>
    change({ ...plan, moments: { ...plan.moments, [moment]: { ...plan.moments[moment], ...patch } } });

  return (
    <View style={styles.panel} testID="studio-sounds">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle">Sounds in this scene</Text>
          <Text variant="rowSub" style={styles.muted}>
            {sounds.saves ? "Each moment plays the same sound every time" : "Changes last until you close the studio"}
          </Text>
        </View>
        <Switch value={plan.on} onValueChange={(on) => change({ ...plan, on })} label="Sounds" testID="studio-sounds-all" />
      </View>
      {sounds.problem === null ? null : (
        <Text variant="rowSub" style={styles.problem}>
          {sounds.problem}
        </Text>
      )}
      <ScrollView contentContainerStyle={styles.list}>
        {CAST_MOMENTS.map((moment) => {
          const choice = plan.moments[moment];
          const isOpen = open === moment;
          const unused = counts[moment] === 0;
          return (
            <View key={moment} style={[styles.moment, isOpen ? styles.momentOpen : null]}>
              <Pressable
                onPress={() => setOpen(isOpen ? null : moment)}
                accessibilityRole="button"
                aria-expanded={isOpen}
                accessibilityLabel={`${MOMENT_LABELS[moment]}: ${soundLabel(choice.sound)}`}
                style={styles.momentHead}
                testID={`studio-sound-${moment}`}
              >
                <View style={styles.headText}>
                  <Text variant="rowTitle" style={!plan.on || unused ? styles.muted : null}>
                    {MOMENT_LABELS[moment]}
                  </Text>
                  <Text variant="rowSub" style={styles.muted}>
                    {momentCount(counts[moment])}
                  </Text>
                </View>
                <Text variant="rowSub" style={choice.sound === "off" || !plan.on ? styles.muted : styles.chosen}>
                  {soundLabel(choice.sound)}
                </Text>
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} color={colors.muted} />
              </Pressable>
              {isOpen ? (
                <View style={styles.options} accessibilityRole="radiogroup" aria-label={MOMENT_LABELS[moment]}>
                  {[...MOMENT_SOUNDS[moment], ...(isUploadedSound(choice.sound) ? [choice.sound] : []), "off"].map((id) => {
                    const on = choice.sound === id;
                    return (
                      <View key={id} style={[styles.option, on ? styles.optionOn : null]}>
                        <Pressable
                          onPress={() => {
                            choose(moment, { sound: id });
                            if (id !== "off") sounds.hear(id, choice.volume);
                          }}
                          accessibilityRole="radio"
                          aria-checked={on}
                          style={styles.optionPick}
                          testID={`studio-sound-${moment}-${id}`}
                        >
                          <View style={[styles.radio, on ? styles.radioOn : null]} />
                          <Text variant="rowSub" style={on ? styles.chosen : styles.optionText}>
                            {soundLabel(id)}
                          </Text>
                        </Pressable>
                        {id === "off" ? null : (
                          <Pressable
                            onPress={() => sounds.hear(id, choice.volume)}
                            accessibilityRole="button"
                            accessibilityLabel={`Hear ${soundLabel(id)}`}
                            style={styles.hear}
                          >
                            <Icon name="speaker" size={16} color={on ? colors.accentText : colors.muted} />
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                  {sounds.upload === undefined ? null : (
                    <Pressable
                      onPress={() => pickSound((file) => void sounds.upload?.(moment, file))}
                      disabled={sounds.uploading !== null}
                      accessibilityRole="button"
                      style={[styles.optionPick, sounds.uploading !== null ? styles.dim : null]}
                      testID={`studio-sound-${moment}-upload`}
                    >
                      <Icon name="plus" size={14} color={colors.muted} />
                      <Text variant="rowSub" style={styles.optionText}>
                        {sounds.uploading === moment ? "Uploading…" : "Upload your own sound"}
                      </Text>
                    </Pressable>
                  )}
                  {choice.sound === "off" ? null : (
                    <View style={styles.volume}>
                      <Text variant="rowSub" style={styles.muted}>
                        {`Volume ${choice.volume}%`}
                      </Text>
                      <View style={styles.volumeButtons}>
                        <VolumeButton
                          label="Quieter"
                          glyph="−"
                          disabled={choice.volume <= 0}
                          onPress={() => choose(moment, { volume: Math.max(0, choice.volume - VOLUME_STEP) })}
                        />
                        <VolumeButton
                          label="Louder"
                          glyph="+"
                          disabled={choice.volume >= 100}
                          onPress={() => choose(moment, { volume: Math.min(100, choice.volume + VOLUME_STEP) })}
                        />
                      </View>
                    </View>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** The browser's file chooser, for one sound file. The studio is web only. */
function pickSound(then: (file: File) => void) {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/x-m4a,.mp3,.wav,.ogg,.m4a";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file !== undefined) then(file);
  };
  input.click();
}

function VolumeButton({ label, glyph, disabled, onPress }: { label: string; glyph: string; disabled: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.volumeButton, disabled ? styles.dim : null]}
    >
      <Text variant="rowTitle">{glyph}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { width: 340, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line, backgroundColor: colors.chromeSurface },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, padding: space.x4 },
    headText: { flex: 1, minWidth: 0 },
    muted: { color: colors.muted },
    chosen: { color: colors.text, fontWeight: "600" },
    problem: { paddingHorizontal: space.x4, paddingBottom: space.x2, color: colors.crit },
    list: { paddingHorizontal: space.x2, paddingBottom: space.x5, gap: 2 },
    moment: { borderRadius: radii.xl },
    momentOpen: { backgroundColor: colors.chipFill },
    momentHead: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 52, paddingHorizontal: space.x3 },
    options: { paddingHorizontal: space.x2, paddingBottom: space.x3, gap: 2 },
    option: { flexDirection: "row", alignItems: "center", borderRadius: radii.lg },
    optionOn: { backgroundColor: colors.accentDim },
    optionPick: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 40, paddingHorizontal: space.x3 },
    optionText: { color: colors.text2 },
    radio: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.muted },
    radioOn: { borderColor: colors.accent, borderWidth: 4.5 },
    hear: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    volume: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.x3, paddingTop: space.x2 },
    volumeButtons: { flexDirection: "row", gap: space.x1 },
    volumeButton: { width: 36, height: 36, borderRadius: radii.lg, alignItems: "center", justifyContent: "center", backgroundColor: colors.pageSurface },
    dim: { opacity: 0.4 },
  });
