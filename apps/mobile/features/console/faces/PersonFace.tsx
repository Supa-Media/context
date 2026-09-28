import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Text } from "../../design/components/Text";
import { defaultFace } from "./defaultFace";
import type { ShownFace } from "./faceStore";
import { useFace } from "./useFace";

/**
 * A person, drawn as their face: a photo, their workspace's emoji, or the
 * Supa mark on a ground colour from their handle. Never initials (Dev2,
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
  /** Chooses the default face's ground colour when there is no face. */
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
        <DefaultFigure name={name} size={size} testID={`${testID}-drawn`} />
      )}
    </View>
  );
}

/** The Supa mark on the handle's ground; `defaultFace.ts` has the rule. */
function DefaultFigure({ name, size, testID }: { name: string | null | undefined; size: number; testID: string }) {
  const face = defaultFace(name);
  return (
    <View style={[styles.fill, { backgroundColor: face.ground }]} testID={testID}>
      <Image source={{ uri: face.logo }} style={{ width: size, height: size }} />
    </View>
  );
}

const styles = StyleSheet.create({
  face: { overflow: "hidden", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  fill: { width: "100%", height: "100%" },
});
