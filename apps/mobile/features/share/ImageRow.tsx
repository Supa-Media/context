/**
 * A line of image embeds on a published page (`markdown.ts`'s `images` block).
 *
 * Only a picture the page carried is drawn, as the `data:` URL it arrived as
 * (`publishedImages.ts`): nothing here fetches `target`, so a shared note's
 * `![[…]]` still shows as its words, and a site's pasted screenshot shows as
 * itself. Width and alignment are the editor's (`imageLine.ts`): a width in
 * the pipe caps the picture, never stretches it past the column.
 */

import { createContext, useContext, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { ImageAlign } from "../console/files/imageLine";
import { NO_PUBLISHED_IMAGES, type PublishedImages } from "./publishedImages";

/** The pictures the page carries, by leaf. */
export const Pictures = createContext<PublishedImages>(NO_PUBLISHED_IMAGES);

const JUSTIFY: Record<ImageAlign, "flex-start" | "center" | "flex-end"> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

export function ImageRow({
  images,
  align,
}: {
  images: readonly { target: string; alt: string; width: number | null }[];
  align: ImageAlign;
}) {
  const styles = useThemedStyles(makeStyles);
  const pictures = useContext(Pictures);
  return (
    <View style={[styles.row, { justifyContent: JUSTIFY[align] }]} testID="note-images">
      {images.map((image, index) => {
        const src = pictures[image.target];
        if (src === undefined) {
          return (
            <Text key={index} variant="body" style={styles.missing}>
              {image.alt === "" ? image.target : image.alt}
            </Text>
          );
        }
        return <Picture key={index} src={src} alt={image.alt === "" ? image.target : image.alt} width={image.width} />;
      })}
    </View>
  );
}

function Picture({ src, alt, width }: { src: string; alt: string; width: number | null }) {
  const styles = useThemedStyles(makeStyles);
  // The picture's own shape, once it has loaded; until then a square holds its place.
  const [ratio, setRatio] = useState<number | null>(null);
  return (
    <Image
      source={{ uri: src }}
      accessibilityLabel={alt}
      testID="note-image"
      resizeMode="contain"
      onLoad={(event) => {
        const { width: w, height: h } = event.nativeEvent.source ?? {};
        if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) setRatio(w / h);
      }}
      style={[styles.picture, { aspectRatio: ratio ?? 1 }, width === null ? { width: "100%" } : { width, maxWidth: "100%" }]}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    picture: { borderRadius: radii.sm },
    missing: { color: colors.muted, fontStyle: "italic" },
  });
