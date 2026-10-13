import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../design/components/Text";
import { layout } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { useReducedMotion } from "../design/useReducedMotion";
import { useChaosView } from "./ChaosContext";
import { Tex } from "./Tex";
import { askYourAi, folderTexShows, texLine, texSays, type ChaosFolder } from "./chaosModel";
import { makeChaosStyles } from "./styles";
import { useTug } from "./useTug";

/** Tex beside a folder's title: big enough to read, small enough to sit on the title's line. */
const FIGURE = 40;
/** How far the words travel in from the right, and how long they take. */
const ROLL_FROM = 28;
const ROLL_MS = 420;
const ROLL_DELAY_MS = 250;

/**
 * A crowded or thin folder's Tex, beside its title (Dev2's pick, 2026-10-13:
 * board 04 of "Showing the chaos score", with these changes): Tex stressed,
 * tugging at its own yarn; "14 things in here · calm is 4 or 5" rolling in
 * from the right; and a press on Tex has it say how this folder could be
 * calmer. A calm folder's page has no Tex at all.
 *
 * Asked for this folder by name (`chaosScore`'s `folder`), again whenever the
 * workspace's score is (`version`), so it moves when the tree does.
 */
export function FolderTex({
  folder,
  ownLine = false,
}: {
  folder: string;
  /** Under a phone's big title rather than beside it: no room to borrow from the title's line. */
  ownLine?: boolean;
}) {
  const view = useChaosView();
  const styles = useThemedStyles(makeChaosStyles);
  const reduced = useReducedMotion();
  const [mine, setMine] = useState<ChaosFolder | null>(null);
  const [talking, setTalking] = useState(false);
  const roll = useRef(new Animated.Value(0)).current;
  const ask = view?.folderScore;
  const version = view?.version;
  useEffect(() => {
    setMine(null);
    setTalking(false);
    if (ask === undefined) return undefined;
    let live = true;
    ask(folder)
      .then((answer) => {
        if (live) setMine(answer !== null && answer.available ? answer.folder : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ask, folder, version]);
  const shows = view !== undefined && folderTexShows(mine);
  const tug = useTug(shows);
  // The words roll in once Tex has something to say, and again on another folder.
  useEffect(() => {
    roll.setValue(0);
    if (!shows) return undefined;
    if (reduced) {
      roll.setValue(1);
      return undefined;
    }
    const run = Animated.timing(roll, {
      toValue: 1,
      duration: ROLL_MS,
      delay: ROLL_DELAY_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    run.start();
    return () => run.stop();
  }, [shows, reduced, roll, folder]);
  if (view === undefined || !folderTexShows(mine)) return null;
  const line = texLine(mine);
  return (
    <View style={[styles.folderTex, ownLine && styles.folderTexOwnLine]} testID="folder-tex">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.lead}, ${line.tail}. Ask Tex how to calm this folder`}
        onPress={() => setTalking(true)}
        style={({ pressed }) => [styles.folderTexFigure, ownLine && styles.folderTexFigureOwnLine, pressed ? styles.pressed : null]}
        testID="folder-tex-figure"
      >
        <Tex chaos={mine.chaos} size={FIGURE} tug={tug} />
      </Pressable>
      <Animated.View
        style={[
          styles.folderTexWords,
          {
            opacity: roll,
            transform: [{ translateX: roll.interpolate({ inputRange: [0, 1], outputRange: [ROLL_FROM, 0] }) }],
          },
        ]}
        aria-hidden
        testID="folder-tex-line"
      >
        <Text variant="tree" numberOfLines={1} style={styles.folderTexLead}>
          {line.lead}
          <Text variant="tree" style={styles.muted}>{` · ${line.tail}`}</Text>
        </Text>
      </Animated.View>
      {talking ? (
        <TexTalks
          folder={mine}
          tug={tug}
          onClose={() => setTalking(false)}
          onWholeScore={() => {
            setTalking(false);
            view.openPanel("sheet");
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * What Tex says when pressed: this folder's count, what calm is, and how to
 * get there, in plain words. Advice only: there is no button here that moves
 * anything (`docs/decisions/chaos-score.md`). A bottom sheet on a phone, a
 * card in the middle of a wider window, as `ChaosSheet` is.
 */
function TexTalks({
  folder,
  tug,
  onClose,
  onWholeScore,
}: {
  folder: ChaosFolder;
  tug: number | undefined;
  onClose: () => void;
  onWholeScore: () => void;
}) {
  const styles = useThemedStyles(makeChaosStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= layout.narrowBreakpoint;
  const says = texSays(folder);
  return (
    <Modal transparent animationType={wide ? "fade" : "slide"} visible onRequestClose={onClose}>
      <Pressable style={[styles.scrim, wide && styles.scrimWide]} accessibilityLabel="Close" onPress={onClose}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={wide ? styles.sheetWide : [styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Tex on this folder"
          testID="folder-tex-talk"
        >
          {wide ? null : <View style={styles.grabber} aria-hidden />}
          <ScrollView style={styles.scroll}>
            <View style={styles.body}>
              <View style={styles.head}>
                <Tex chaos={folder.chaos} size={wide ? 88 : 96} tug={tug} />
                <Text variant="rowTitle" style={[styles.word, styles.headText]}>
                  {says.lead}
                </Text>
              </View>
              <View style={styles.section}>
                {says.tips.map((tip) => (
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
                testID="folder-tex-whole"
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
