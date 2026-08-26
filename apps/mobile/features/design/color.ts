/**
 * `#RRGGBB` + alpha → `rgba(…)`.
 *
 * The mockup does this by concatenating hex alpha onto the colour (`c+'44'`),
 * which only works because every palette entry there is a 6-digit hex. Going
 * through `rgba()` keeps it correct if one ever isn't, and unparseable input is
 * returned untouched rather than silently becoming black.
 */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
