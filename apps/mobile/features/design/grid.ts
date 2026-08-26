/**
 * CSS Grid's `repeat(auto-fit, minmax(<min>, 1fr))`, worked out in JavaScript.
 *
 * React Native has no grid, and the obvious flexbox substitute — `flexWrap`
 * with `flexGrow: 1` — gets the last row wrong: a lone item on the final row
 * stretches to the full width instead of staying one column wide. That is
 * visible on the Storage pane, where "Access key" sits alone under three other
 * fields and must line up with the first column.
 */

/** How many columns `auto-fit` would produce at this container width. */
export function autoFitColumns(
  containerWidth: number,
  minItemWidth: number,
  gap: number,
): number {
  if (containerWidth <= 0 || minItemWidth <= 0) return 1;
  // n columns need n*min + (n-1)*gap ≤ width, i.e. n ≤ (width+gap)/(min+gap).
  return Math.max(1, Math.floor((containerWidth + gap) / (minItemWidth + gap)));
}

/** The width each `1fr` column resolves to, once the gaps are taken out. */
export function autoFitItemWidth(
  containerWidth: number,
  minItemWidth: number,
  gap: number,
): number {
  if (containerWidth <= 0) return 0;
  const columns = autoFitColumns(containerWidth, minItemWidth, gap);
  return (containerWidth - gap * (columns - 1)) / columns;
}
