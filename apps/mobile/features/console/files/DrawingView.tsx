import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Ellipse, G, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { Text } from "../../design/components/Text";
import { fonts, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  buildScene,
  describeDrawing,
  parseDrawing,
  type Drawing,
  type SceneNode,
} from "@context/drawings";

/**
 * An Excalidraw drawing, drawn.
 *
 * ## Why this is `react-native-svg` and not Excalidraw
 *
 * Excalidraw's own renderer is React DOM plus `roughjs` plus a canvas context:
 * it runs in a browser and nowhere else. This component has to draw the same
 * file on iOS, Android and web, in a console whose native half is React Native
 * — so it draws from `buildScene`, which turns parsed elements into primitives
 * (`packages/drawings/src/scene.js`) and is tested without mounting anything.
 * `react-native-svg` is already in `native-deps.json`, so this costs no new
 * native dependency and no new build step.
 *
 * The trade is stated where the geometry is: shapes come out **true** rather
 * than hand-drawn. `roughjs` re-strokes every edge several times from a seeded
 * RNG, and reproducing that is a lot of code whose output is meant to be
 * imprecise and which changes upstream. A preview that looks slightly too tidy
 * is worth more than one that is wrong in ways nobody can predict — and the
 * file is untouched either way, so the real rendering is one click away in
 * Obsidian or on excalidraw.com. That portability is the whole reason the file
 * stays plain.
 *
 * ## It never fails to render something
 *
 * A drawing whose payload is missing, oversized or undecodable still arrives
 * here as a parse — with its labels, because the plugin writes those into the
 * Markdown half as plain text. So this falls back to the same description the
 * gateway gives an agent rather than to an error, and says which of those
 * happened. The reason is in `lzstring.js`: the cost of a bug in the decoder
 * must be a missing picture, never a file that will not open.
 *
 * ## The colours are the drawing's, not the theme's
 *
 * Everything inside the frame is painted with the colours the person chose when
 * they drew it — theming their content would be changing it. What the theme
 * owns is the frame: the paper the drawing sits on, its border, and the caption
 * under it. On a dark theme the paper stays light for the same reason a
 * photograph does; a drawing made on white and re-grounded on black loses every
 * contrast decision in it.
 */
export function DrawingView({
  path,
  source,
  maxHeight = 420,
}: {
  path: string;
  source: string;
  maxHeight?: number;
}) {
  const styles = useThemedStyles(makeStyles);

  const { scene, drawing } = useMemo(() => {
    const parsed = parseDrawing(source, path);
    return { drawing: parsed, scene: parsed.elements ? buildScene(parsed.elements) : null };
  }, [source, path]);

  if (!scene || scene.nodes.length === 0) {
    return (
      <View style={styles.frame} accessibilityRole="image" accessibilityLabel={`Drawing: ${drawing.name}`}>
        <Text variant="rowSub">{describeDrawing(drawing, { path })}</Text>
      </View>
    );
  }

  const { viewBox } = scene;
  // Let the drawing keep its aspect ratio inside whatever width it is given,
  // and cap the height so a tall diagram does not push the note off the screen.
  const ratio = viewBox.width / viewBox.height;

  return (
    <View style={styles.frame}>
      <View
        style={[styles.paper, { maxHeight, aspectRatio: ratio }]}
        accessibilityRole="image"
        accessibilityLabel={`Drawing: ${drawing.name}. ${labelSummary(drawing)}`}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        >
          {scene.nodes.map((node) => (
            <SceneShape key={node.id} node={node} />
          ))}
        </Svg>
      </View>
      <Text variant="rowSub">
        {drawing.name}
        {scene.truncated ? " — showing the first part of a large drawing" : ""}
      </Text>
    </View>
  );
}

/**
 * One primitive.
 *
 * A flat switch rather than a component per shape: the scene is already the
 * decision, and a second layer of components would be a second place for a
 * shape to be drawn differently from how it was laid out.
 */
function SceneShape({ node }: { node: SceneNode }) {
  const rotation = node.rotate
    ? `rotate(${node.rotate.degrees} ${node.rotate.cx} ${node.rotate.cy})`
    : undefined;

  const stroke = {
    stroke: node.stroke,
    strokeWidth: node.strokeWidth,
    strokeDasharray: node.strokeDasharray ?? undefined,
    opacity: node.opacity,
  } as const;

  const body = (() => {
    switch (node.kind) {
      case "rect":
        return (
          <Rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={node.rx}
            fill={node.fill}
            fillOpacity={node.fillOpacity}
            {...stroke}
          />
        );
      case "ellipse":
        return (
          <Ellipse
            cx={node.cx}
            cy={node.cy}
            rx={node.rx}
            ry={node.ry}
            fill={node.fill}
            fillOpacity={node.fillOpacity}
            {...stroke}
          />
        );
      case "polygon":
        return (
          <Polygon
            points={node.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill={node.fill}
            fillOpacity={node.fillOpacity}
            strokeLinejoin="round"
            {...stroke}
          />
        );
      case "path":
        return (
          <Path
            d={node.d}
            fill={node.fill}
            fillOpacity={node.fillOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...stroke}
          />
        );
      case "text":
        return (
          <>
            {node.lines.map((line, index) => (
              <SvgText
                key={index}
                x={line.x}
                y={line.y}
                fontSize={node.fontSize}
                fontFamily={FONT_STACK[node.fontFamily] ?? FONT_STACK.hand}
                fill={node.fill}
                opacity={node.opacity}
                textAnchor={node.anchor}
              >
                {line.text}
              </SvgText>
            ))}
          </>
        );
      default:
        return null;
    }
  })();

  return rotation ? <G transform={rotation}>{body}</G> : body;
}

/**
 * What each Excalidraw font family becomes here.
 *
 * Excalidraw's own faces (Excalifont, Virgil) are not bundled — shipping three
 * more font files to every phone to make a preview marginally more authentic is
 * not a trade worth making. Each maps to the nearest thing the platform already
 * has, and a drawing's *text* is the part that has to stay legible rather than
 * the part that has to look hand-drawn.
 */
const FONT_STACK: Record<string, string | undefined> = {
  // `undefined` on native is the platform font, which is what these resolve to
  // there — `fonts.body` is a web-only stack by construction (`tokens.ts`).
  hand: fonts.body,
  sans: fonts.body,
  mono: fonts.mono,
};

/** The first few labels, for a screen reader that cannot see the picture. */
function labelSummary(drawing: Drawing): string {
  const labels = drawing.textElements.slice(0, 6).map((element) => element.text.replace(/\s+/g, " "));
  if (labels.length === 0) return "No labels.";
  const more = drawing.textElements.length > labels.length ? ", and more" : "";
  return `Labelled: ${labels.join(", ")}${more}.`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    frame: {
      gap: space.x2,
    },
    /*
      Light paper in both themes, on purpose — see the header. The border and
      the caption are the theme's; what is inside the frame is the customer's.
    */
    paper: {
      backgroundColor: "#ffffff",
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: "hidden",
      width: "100%",
    },
  });
