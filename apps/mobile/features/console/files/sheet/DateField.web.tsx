/**
 * A date cell's editor in the browser: the platform's own date input, which
 * brings its picker and takes YYYY-MM-DD. Enter is read by the grid's
 * keyboard handler, so the input does not submit by itself.
 */

import { useColors } from "../../../design/theme";
import { pointerType } from "../../../design/tokens";
import { useFieldFont } from "../../../design/fieldFont";

export function DateField({
  value,
  label,
  onChange,
  onBlur,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onSubmit?: () => void;
}) {
  const colors = useColors();
  // 16px on a phone, so the browser does not zoom into the field.
  const fieldFont = useFieldFont(pointerType.ui);
  return (
    <input
      type="date"
      autoFocus
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      data-testid="sheet-cell-editor"
      style={{
        width: "100%",
        height: 26,
        boxSizing: "border-box",
        padding: "0 6px",
        border: `1px solid ${colors.accent}`,
        borderRadius: 6,
        background: colors.ground,
        color: colors.text,
        font: "inherit",
        fontSize: fieldFont?.fontSize ?? pointerType.ui,
      }}
    />
  );
}
