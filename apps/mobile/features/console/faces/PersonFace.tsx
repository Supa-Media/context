import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Circle, Defs, Ellipse, LinearGradient, Rect, Stop, Svg } from "react-native-svg";

import { Text } from "../../design/components/Text";
import { defaultFace, FACE_SHAPES } from "./defaultFace";
import type { ShownFace } from "./faceStore";
import { useFace } from "./useFace";

/**
 * A person, drawn as their face: a photo, their workspace's emoji, or the
 * drawn figure in colours from their handle. Never initials (Dev2,
 * 2026-09-28: "I really hate the SE SH").
 *
 * Circular and `size` square. The name is not drawn or announced here: every
 * caller puts it beside the face or in its own label, so this is `aria-hidden`.
 */
export function PersonFace({
  name,
  size,
  style,
  testID = "person-face",
}: {
  /** "@seyi", as the surface names the person. */
  name: string | null | undefined;
  size: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const face = useFace(name);
  return <FaceView face={face} name={name} size={size} style={style} testID={testID} />;
}

/** The drawing alone, for a caller that already holds the face. */
export function FaceView({
  face,
  name,
  size,
  style,
  testID = "person-face",
}: {
  face: ShownFace | undefined;
  /** Chooses the drawn figure's colours when there is no face. */
  name: string | null | undefined;
  size: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={[styles.face, box, style]} aria-hidden testID={testID}>
      {face?.kind === "photo" ? (
        <Image source={{ uri: face.uri }} style={box} testID={`${testID}-photo`} />
      ) : face?.kind === "emoji" ? (
        <Text
          style={{ fontSize: Math.round(size * 0.62), lineHeight: size, textAlign: "center" }}
          testID={`${testID}-emoji`}
        >
          {face.emoji}
        </Text>
      ) : (
        <DefaultFigure name={name} testID={`${testID}-drawn`} />
      )}
    </View>
  );
}

/** The drawn head and shoulders; `defaultFace.ts` has the rule and the shapes. */
function DefaultFigure({ name, testID }: { name: string | null | undefined; testID: string }) {
  const face = defaultFace(name);
  const id = `cx-face-${face.index}`;
  const { shirt, skin, hair } = FACE_SHAPES;
  return (
    <View style={styles.fill} testID={testID}>
      <Svg width="100%" height="100%" viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={face.groundTop} />
            <Stop offset="1" stopColor={face.groundBottom} />
          </LinearGradient>
        </Defs>
        <Rect width={100} height={100} fill={`url(#${id})`} />
        <Ellipse cx={shirt.cx} cy={shirt.cy} rx={shirt.rx} ry={shirt.ry} fill={face.shirt} />
        <Circle cx={skin.cx} cy={skin.cy} r={skin.r} fill={face.skin} />
        <Circle cx={hair.cx} cy={hair.cy} r={hair.r} fill={face.hair} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  face: { overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  fill: { width: "100%", height: "100%" },
});
