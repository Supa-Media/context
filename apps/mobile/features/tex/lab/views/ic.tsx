/** The artifact's `ic()`: one of its drawn icons (`data/graph.ts` ICONS, static paths), as an inline SVG. */
import type { CSSProperties } from "react";
import { ICONS } from "../data/graph";

export function Ic({ k, style, className = "i" }: { k: string; style?: CSSProperties; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" style={style} dangerouslySetInnerHTML={{ __html: ICONS[k] || ICONS.code }} />;
}
