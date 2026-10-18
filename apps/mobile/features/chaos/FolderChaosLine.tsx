import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../design/components/Text";
import { layout } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { useChaosView } from "./ChaosContext";
import { askYourAi, folderAdvice, folderLine, folderLineShows, type ChaosFolder } from "./chaosModel";
import { makeChaosStyles } from "./styles";
import { cachedFolderLine, folderLinesVersion, readFolderLine, subscribeFolderLines } from "./folderLineCache";

/**
 * A crowded or thin folder's one quiet line, beside its title: "14 things in
 * here · calm is 4 or 5", in muted type. A press says how this folder could
 * be calmer. A calm folder's page has no line at all.
 *
 * Words only, no figure: Tex was drawn here and at the tree's foot until Dev2
 * took it out of the app (2026-10-14). The homepage keeps Tex.
 *
 * Asked for this folder by name (`chaosScore`'s `folder`), again whenever the
 * workspace's score is (`version`), so it moves when the tree does.
 */
export function FolderChaosLine({
  folder,
  ownLine = false,
}: {
  folder: string;
  /** Under a phone's big title rather than beside it: no room to borrow from the title's line. */
  ownLine?: boolean;
}) {
  const view = useChaosView();
  const styles = useThemedStyles(makeChaosStyles);
  const [advising, setAdvising] = useState(false);
  const ask = view?.folderScore;
  const version = view?.version;
  // Kept per workspace and usually asked by the press that opened the page (`folderLineCache`).
  useSyncExternalStore(subscribeFolderLines, folderLinesVersion, folderLinesVersion);
  const mine = cachedFolderLine(ask, folder) ?? null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    setAdvising(false);
  }, [folder]);
  useEffect(() => {
    if (ask === undefined) return;
    // Asked again when the workspace's score moves, and on every visit: what is kept is drawn meanwhile.
    const key = `${folder}\u0000${String(version)}`;
    if (asked.current === key) return;
    asked.current = key;
    void readFolderLine(ask, folder, cachedFolderLine(ask, folder) !== undefined);
  }, [ask, folder, version]);
  if (view === undefined || !folderLineShows(mine)) return null;
  const line = folderLine(mine);
  return (
    <View style={[styles.folderLine, ownLine && styles.folderLineOwnLine]} testID="folder-chaos">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.lead}, ${line.tail}. How to calm this folder`}
        onPress={() => setAdvising(true)}
        style={({ pressed }) => [styles.folderLinePress, pressed ? styles.pressed : null]}
        testID="folder-chaos-line"
      >
        <Text variant="tree" numberOfLines={1} style={styles.muted}>
          {`${line.lead} · ${line.tail}`}
        </Text>
      </Pressable>
      {advising ? (
        <FolderAdvice
          folder={mine}
          onClose={() => setAdvising(false)}
          onWholeScore={() => {
            setAdvising(false);
            view.openPanel("sheet");
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * How this folder could be calmer, in plain words. Advice only: there is no
 * button here that moves anything (`docs/decisions/chaos-score.md`). A bottom
 * sheet on a phone, a card in the middle of a wider window, as `ChaosSheet` is.
 */
function FolderAdvice({
  folder,
  onClose,
  onWholeScore,
}: {
  folder: ChaosFolder;
  onClose: () => void;
  onWholeScore: () => void;
}) {
  const styles = useThemedStyles(makeChaosStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= layout.narrowBreakpoint;
  const advice = folderAdvice(folder);
  return (
    <Modal transparent animationType={wide ? "fade" : "slide"} visible onRequestClose={onClose}>
      <Pressable style={[styles.scrim, wide && styles.scrimWide]} accessibilityLabel="Close" onPress={onClose}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={wide ? styles.sheetWide : [styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Calming this folder"
          testID="folder-chaos-advice"
        >
          {wide ? null : <View style={styles.grabber} aria-hidden />}
          <ScrollView style={styles.scroll}>
            <View style={styles.body}>
              <Text variant="rowTitle" style={[styles.word, styles.adviceLead]}>
                {advice.lead}
              </Text>
              <View style={styles.section}>
                {advice.tips.map((tip) => (
                  <View key={tip} style={styles.tip}>
                    <Text variant="tree" style={styles.muted} aria-hidden>
                      •
                    </Text>
                    <Text variant="tree" style={styles.tipText}>
                      {tip}
                    </Text>
                  </View>
                ))}
              </View>
              <Text variant="treeMeta" style={styles.how}>
                {askYourAi(folder)}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onWholeScore}
                style={({ pressed }) => [styles.tip, pressed ? styles.pressed : null]}
                testID="folder-chaos-whole"
              >
                <Text variant="treeMeta" style={styles.link}>
                  The whole workspace’s score ›
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
