import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useThemedStyles, type Colors } from "../design/theme";
import type { Shadows } from "../design/tokens";
import { fitScale } from "./studioFrames";
import type { StudioStageProps } from "./StudioStage";

/**
 * The stage: the homepage itself, in an iframe the size of a real window for
 * the frame, scaled to fit the space it has. Scaling rather than resizing is
 * what keeps a phone frame the phone layout however large it is drawn.
 *
 * The page cannot be clicked: a click in it is a visitor's edit, which stops
 * the show (`castRun.ts`), and the studio's controls are what drive it. It
 * runs our own page, same origin, scripts on; like the drawing editor's
 * frame, it may not navigate the studio away, open popups or submit forms.
 */
export function StudioStage({ frame, src, attach, bare = false }: StudioStageProps) {
  const styles = useThemedStyles(makeStyles);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const scale = fitScale(frame, box);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((current) => (current.width === width && current.height === height ? current : { width, height }));
  };
  return (
    <View style={styles.box} onLayout={onLayout}>
      {scale > 0 ? (
        <View
          style={[styles.window, bare ? styles.bare : null, { width: frame.width * scale, height: frame.height * scale }]}
          testID="studio-stage"
        >
          <iframe
            ref={attach}
            src={src}
            title={`${frame.label} preview`}
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
            style={{
              border: "none",
              display: "block",
              width: frame.width,
              height: frame.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              pointerEvents: "none",
              cursor: bare ? "none" : undefined,
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

// The window has an edge and a lift, so a page as pale as the studio still
// reads as a screen; recording drops both, since they would be in the take.
const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    box: { flex: 1, minHeight: 0, minWidth: 0, alignItems: "center", justifyContent: "center" },
    window: {
      overflow: "hidden",
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      boxShadow: shadows.floating,
    } as never,
    bare: { borderRadius: 0, borderWidth: 0, boxShadow: "none" } as never,
  });
