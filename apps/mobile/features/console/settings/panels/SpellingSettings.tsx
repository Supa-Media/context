import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Icon } from "../../../design/components/Icon";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { leading, pointerType, radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  SPELLING_LANGUAGES,
  forgetWord,
  getSpelling,
  setSpellingEnabled,
  setSpellingLanguage,
  subscribeSpelling,
} from "../../files/spelling/store";
import { settingsSectionLabel } from "../sections";

/**
 * Settings › Spelling (Dev2, 2026-10-27, board 4): one switch for spelling
 * fixes, the dictionary's language, and the words the person added with
 * a way to take each back.
 *
 * Reads and writes `spelling/store.ts`, which shows a change at once and saves
 * it on the account (`useSpellingSync`), so the page and every open note agree
 * without waiting on the server.
 */
export function SpellingSettings() {
  const styles = useThemedStyles(makeStyles);
  const spelling = useSyncExternalStore(subscribeSpelling, getSpelling, getSpelling);
  const words = [...spelling.words].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("spelling")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Fixes for misspelled words, on every device you sign in on. Right-click a word to
        see them. Nothing is underlined.
      </Text>

      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Check spelling</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Turn off to stop spelling fixes everywhere.
            </Text>
          </Grow>
          <Switch
            value={spelling.enabled}
            onValueChange={setSpellingEnabled}
            label="Check spelling"
            testID="spelling-enabled"
          />
        </Row>
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Language</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Which English the dictionary spells.
            </Text>
          </Grow>
          <View style={styles.track} role="radiogroup" aria-label="Language" testID="spelling-language">
            {SPELLING_LANGUAGES.map((option) => {
              const on = option.key === spelling.language;
              return (
                <Pressable
                  key={option.key}
                  role="radio"
                  aria-checked={on}
                  onPress={() => setSpellingLanguage(option.key)}
                  style={[styles.chip, on && styles.chipOn]}
                  testID={`spelling-language-${option.key}`}
                >
                  <Text style={[styles.label, on && styles.labelOn]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Row>
        <Row divided style={styles.wordsRow}>
          <Grow>
            <Text variant="rowTitle">Your dictionary</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {words.length === 0
                ? "Words you add from a word's right-click menu show up here. Nothing yet."
                : "Words you added. They are never offered a fix, in any workspace."}
            </Text>
            {words.length === 0 ? null : (
              <View style={styles.words} testID="spelling-words">
                {words.map((word) => (
                  <View key={word.toLowerCase()} style={styles.word}>
                    <Text style={styles.wordText} numberOfLines={1}>
                      {word}
                    </Text>
                    <Pressable
                      onPress={() => forgetWord(word)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${word} from your dictionary`}
                      hitSlop={6}
                      style={styles.remove}
                      testID={`spelling-forget-${word.toLowerCase()}`}
                    >
                      <Icon name="close" size={12} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </Grow>
        </Row>
      </Card>
      {spelling.status === "failed" ? (
        <Text variant="hint" style={styles.problem} testID="spelling-offline">
          The dictionary couldn't load, so your browser's own checker is on for now.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    rowSub: { marginTop: 2, maxWidth: 520 },
    wordsRow: { alignItems: "flex-start" },
    track: {
      flexDirection: "row",
      gap: 2,
      padding: 2,
      borderRadius: radii.lg,
      backgroundColor: colors.chipFill,
      flexShrink: 0,
    },
    chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 5 },
    chipOn: {
      backgroundColor: colors.surface,
      boxShadow: `0 0 0 1px ${colors.line}, 0 1px 2px rgba(0,0,0,.06)`,
    },
    label: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "500",
      color: colors.muted,
    },
    labelOn: { color: colors.text },
    words: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: space.x2 },
    word: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: 240,
      paddingLeft: 10,
      paddingRight: 4,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.lineStrong,
    },
    wordText: {
      flexShrink: 1,
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      color: colors.text,
    },
    remove: { padding: 3, borderRadius: 999 },
    problem: { marginTop: space.x2, color: colors.muted },
  });
