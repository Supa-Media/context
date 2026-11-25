/**
 * A date cell's editor in the browser: the platform's own date input, which
 * brings its picker and takes YYYY-MM-DD. Enter is read by the grid's
 * keyboard handler, so the input does not submit by itself.
 */

import { useColors, useScheme } from "../../../design/theme";
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
  // The picker the browser draws follows this, so it is not a white panel on the dark app.
  const scheme = useScheme();
  // 16px on a phone, so the browser does not zoom into the field.
  const fieldFont = useFieldFont(pointerType.ui);
  // The browser's picker takes a day only. An instant (`2026-11-24T09:30Z`) shows its
  // day, and picking a day keeps the instant's time rather than dropping it.
  const day = value.slice(0, 10);
  const time = /^\d{4}-\d{2}-\d{2}(T.*)$/.exec(value)?.[1] ?? "";
  return (
    <input
      type="date"
      autoFocus
      aria-label={label}
      value={day}
      onChange={(event) => onChange(event.target.value === "" || time === "" ? event.target.value : event.target.value + time)}
      onBlur={onBlur}
      data-testid="sheet-cell-editor"
      style={{
        width: "100%",
        height: 26,
        boxSizing: "border-box",
        // No frame: the cell's selection ring is the one outline.
        padding: 0,
        border: "none",
        outline: "none",
        background: "transparent",
        colorScheme: scheme,
        color: colors.text,
        font: "inherit",
        fontSize: fieldFont?.fontSize ?? pointerType.ui,
      }}
    />
  );
}
