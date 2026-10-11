import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { radii, space } from "../../../design/tokens";
import { useReducedMotion } from "../../../design/useReducedMotion";
import { DocumentPage } from "./DocumentPage";

/** How long a read may take before the page says it is loading. */
export const NOTE_LOADING_DELAY_MS = 150;

/** The bars' widths, as a share of the column: a heading, then a paragraph. */
const LINES = [0.46, 0.92, 0.84, 0.88, 0.6] as const;

/**
 * A note on its way, drawn where the note will be.
 *
 * Owner, 2026-10-11: opening a note "displayed the 'write in markdown' empty
 * file text and then later populates with the actual text … users [might]
 * think for a split second their file has no content." That was the editor,
 * mounted before the read had landed, showing its placeholder over a note that
 * was nothing of the kind. An empty note and a note that has not arrived are
 * two different things and must never look alike — so until the editor holds
 * the note, this is drawn instead, and there is no editor under it to type
 * into.
 *
 * **Blank first, then the bars.** A read that answers inside
 * `NOTE_LOADING_DELAY_MS` swaps straight to the note, so a fast open never
 * flashes a loading state either. Past it, quiet bars the shape of a heading
 * and a paragraph, breathing unless the viewer asked for reduced motion.
 */
export function NoteLoading({ pathBar, notices }: { pathBar?: ReactNode; notices?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const [shown, setShown] = useState(false);
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setTimeout(() => setShown(true), NOTE_LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!shown || reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shown, reduced, pulse]);

  return (
    <DocumentPage>
      {pathBar}
      {notices}
      <View
        style={styles.page}
        role="progressbar"
        aria-busy
        accessibilityLabel="Opening note"
        testID="note-loading"
      >
        {shown ? (
          <Animated.View style={[styles.lines, { opacity: pulse }]} testID="note-loading-lines">
            {LINES.map((width, index) => (
              <View
                key={index}
                style={[styles.line, index === 0 && styles.heading, { width: `${width * 100}%` }]}
              />
            ))}
          </Animated.View>
        ) : null}
      </View>
    </DocumentPage>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingVertical: space.x6, maxWidth: 720 },
    lines: { gap: space.x3 },
    line: { height: 12, borderRadius: radii.sm, backgroundColor: colors.lineStrong },
    heading: { height: 22, marginBottom: space.x2 },
  });
