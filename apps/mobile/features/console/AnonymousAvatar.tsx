import { View } from "react-native";
import { Circle, Path, Rect, Svg } from "react-native-svg";

/*
  A flat head and shoulders, dark on light grey-blue: the avatar for whoever has
  no name to take an initial from — a homepage visitor, or an account whose
  identity has not loaded. Chosen by the owner on 2026-09-28 over the earlier
  mannequin photo, to match the app's flat style. Drawn rather than shipped as
  an image so it stays sharp at every size.
*/
const BACKGROUND = "#CCD5D7";
const FIGURE = "#1F2B37";

export function AnonymousAvatar() {
  return (
    <View style={{ width: "100%", height: "100%" }} testID="avatar-anonymous">
      <Svg width="100%" height="100%" viewBox="0 0 100 100">
        <Rect width={100} height={100} fill={BACKGROUND} />
        <Circle cx={50} cy={31} r={18} fill={FIGURE} />
        <Path d="M18 74 A32 20 0 0 1 82 74 A32 13 0 0 1 18 74 Z" fill={FIGURE} />
      </Svg>
    </View>
  );
}
