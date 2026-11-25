/**
 * The small drawings of the data pages (the data sources boards): each
 * source's mark on its tile, and the few glyphs the app's icon set has no
 * shape for — a database, a sheet, a warning triangle, a refresh arrow.
 * Plain glyphs, never the companies' logos, drawn as the board draws them
 * (a 16-unit box, round caps) so they sit at the board's sizes exactly.
 */

import type { ReactNode } from "react";
import { View } from "react-native";
import { Circle, Path, Svg } from "react-native-svg";
import { useColors } from "../../../design/theme";
import type { SourceKind } from "./sources";

function Glyph({ size, color, width = 1.5, children }: { size: number; color: string; width?: number; children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </Svg>
  );
}

export function SheetGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color} width={1.2}>
      <Path d="M4 3h8a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 3zM2.5 6.5h11M2.5 10h11M6.5 6.5V13" />
    </Glyph>
  );
}

export function FileGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color} width={1.3}>
      <Path d="M4.5 2h4.5l2.5 2.5V14h-7z" />
    </Glyph>
  );
}

export function FolderGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color} width={1.3}>
      <Path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    </Glyph>
  );
}

export function DatabaseGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color} width={1.3}>
      <Path d="M3 4c0-1 2.2-1.8 5-1.8s5 .8 5 1.8-2.2 1.8-5 1.8S3 5 3 4zM3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
    </Glyph>
  );
}

export function RefreshGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color}>
      <Path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
    </Glyph>
  );
}

export function LockGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color}>
      <Path d="M5 7h6a1.5 1.5 0 0 1 1.5 1.5V12A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V8.5A1.5 1.5 0 0 1 5 7zM5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Glyph>
  );
}

export function PlusGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color}>
      <Path d="M8 3v10M3 8h10" />
    </Glyph>
  );
}

export function ChevronGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color}>
      <Path d="M6 3.5 10.5 8 6 12.5" />
    </Glyph>
  );
}

export function CopyGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Glyph size={size} color={color}>
      <Path d="M7 5.5h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5zM10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </Glyph>
  );
}

export function MoreGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={color} aria-hidden>
      <Circle cx={3.5} cy={8} r={1.2} />
      <Circle cx={8} cy={8} r={1.2} />
      <Circle cx={12.5} cy={8} r={1.2} />
    </Svg>
  );
}

/** The board's filled warning triangle, in the critical colour, its mark cut out in the card's ground. */
export function WarnGlyph({ size }: { size: number }) {
  const colors = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <Path d="M7 .8l6.6 11.8H.4Z" fill={colors.crit} stroke={colors.crit} strokeWidth={0.8} strokeLinejoin="round" />
      <Path d="M7 5v3.4" stroke={colors.cardSurface} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={7} cy={10.5} r={0.95} fill={colors.cardSurface} />
    </Svg>
  );
}

function KindGlyph({ kind, size, color }: { kind: SourceKind; size: number; color: string }) {
  switch (kind) {
    case "github":
      return (
        <Glyph size={size} color={color} width={1.6}>
          <Circle cx={4.5} cy={3.5} r={1.6} />
          <Circle cx={4.5} cy={12.5} r={1.6} />
          <Circle cx={11.5} cy={5.5} r={1.6} />
          <Path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3.4-5.4 4.1" />
        </Glyph>
      );
    case "cloudflare":
      return (
        <Glyph size={size} color={color} width={1.6}>
          <Path d="M4.5 12.5h7.5a2.5 2.5 0 0 0 .3-5A4 4 0 0 0 4.6 6.8 2.9 2.9 0 0 0 4.5 12.5z" />
        </Glyph>
      );
    case "stripe":
      return (
        <Glyph size={size} color={color} width={1.7}>
          <Path d="M11 4.8C10.2 4 9.2 3.6 8 3.6c-1.7 0-2.9.9-2.9 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3.1 2.2-1.3 0-2.5-.5-3.3-1.3" />
        </Glyph>
      );
    case "context":
      return (
        <Glyph size={size} color={color} width={1.7}>
          <Path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M11.5 2.5v2.5H9" />
        </Glyph>
      );
    case "fetch":
      return (
        <Glyph size={size} color={color}>
          <Circle cx={8} cy={8} r={5.5} />
          <Path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z" />
        </Glyph>
      );
    default:
      return (
        <Glyph size={size} color={color}>
          <Path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" />
        </Glyph>
      );
  }
}

/** A source's tile and its ink, by kind. */
export function useMarkColors(kind: SourceKind): { tile: string; ink: string } {
  const colors = useColors();
  switch (kind) {
    case "github":
      return { tile: colors.markGithub, ink: colors.markGithubInk };
    case "cloudflare":
      return { tile: colors.markCloudflare, ink: colors.markCloudflareInk };
    case "stripe":
      return { tile: colors.markStripe, ink: colors.markStripeInk };
    case "context":
      return { tile: colors.accentDim, ink: colors.accentText };
    default:
      return { tile: colors.chipFill, ink: colors.text2 };
  }
}

/**
 * A source's mark on its tile: 13 in a formula chip, 28 on a card and in a
 * phone's row, 36 at the head of its own page — the board's three sizes.
 */
export function SourceMark({ kind, size }: { kind: SourceKind; size: 13 | 28 | 32 | 36 }) {
  const { tile, ink } = useMarkColors(kind);
  const glyph = size === 13 ? 9 : size === 28 ? 16 : 18;
  const radius = size === 13 ? 3.5 : size === 28 ? 8 : 10;
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: tile, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <KindGlyph kind={kind} size={glyph} color={ink} />
    </View>
  );
}
