/**
 * One emoji, drawn: a character as text, or one of the workspace's own as its
 * picture. A folder icon is either (`@context/shared`'s `folderIcons.cjs`), so
 * every place that draws one draws it through here.
 *
 * A workspace emoji is `:name:`, the spelling a note uses, and its picture
 * comes from `CustomEmojiProvider` the way the editor's does. Until it has
 * arrived the slot is held empty at its size, so nothing beside it moves; when
 * there is no picture to be had (the emoji was removed, or nothing provides
 * them here) the caller's `fallback` is drawn instead, which for a folder is
 * the plain folder glyph.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Image, View, type StyleProp, type TextStyle } from "react-native";
import { customEmojiShortcode } from "@context/shared";

import { Text } from "../../design/components/Text";
import { useCustomEmoji } from "./context";

export function EmojiGlyph({
  emoji,
  size,
  textStyle,
  fallback = null,
  testID,
}: {
  emoji: string;
  /** The square a workspace emoji's picture fills, matching the text it stands beside. */
  size: number;
  /** How a character is drawn. */
  textStyle?: StyleProp<TextStyle>;
  /** Drawn when a workspace emoji has no picture. */
  fallback?: ReactNode;
  testID?: string;
}) {
  const name = customEmojiShortcode(emoji);
  if (name === null) {
    return (
      <Text style={textStyle} testID={testID}>
        {emoji}
      </Text>
    );
  }
  return <CustomGlyph name={name} size={size} fallback={fallback} testID={testID} />;
}

function CustomGlyph({
  name,
  size,
  fallback,
  testID,
}: {
  name: string;
  size: number;
  fallback: ReactNode;
  testID?: string;
}) {
  const host = useCustomEmoji();
  // `undefined` while asking, `null` when there is no picture.
  const [src, setSrc] = useState<string | null | undefined>(host === null ? null : undefined);

  useEffect(() => {
    if (host === null) {
      setSrc(null);
      return;
    }
    let live = true;
    setSrc((current) => (current === null ? undefined : current));
    void host.load(name).then((next) => {
      if (live) setSrc(next);
    });
    return () => {
      live = false;
    };
  }, [host, name]);

  if (src === null) return <>{fallback}</>;
  const box = { width: size, height: size };
  if (src === undefined) return <View style={box} testID={testID} />;
  return (
    <Image
      source={{ uri: src }}
      style={box}
      resizeMode="contain"
      accessibilityLabel={`:${name}:`}
      testID={testID}
    />
  );
}
