import type { FillField } from "./browse";
import { refSelector as selector } from "./picker";

/**
 * Pick a card's expiry month or year in a menu: the option whose value or
 * words are that number or month ("08", "8", "8 - Aug", "08 - August",
 * "Aug", "2029", "29"). A one-box expiry ("08/29", `cc-exp`) aimed at a menu
 * picks the month in a month menu and the year in a year menu, told apart by
 * whether its options run past 12 (the owner's review, 2026-10-26: a bus
 * checkout's month menu refused the card, and the person was asked again).
 */
export function pickExpirySource(ref: number, value: string, field: FillField): string {
  return `(() => {
    const el = document.querySelector('${selector(ref)}');
    if (!el || el.tagName !== "SELECT") return false;
    const field = ${JSON.stringify(field)};
    const value = ${JSON.stringify(value)};
    const names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const words = (o) => String(o.innerText || o.textContent || "").replace(/\\s+/g, " ").trim();
    const lead = (s) => (String(s).trim().match(/^\\d+/) || [""])[0];
    const options = [...el.options].filter((o) => !o.disabled);
    const isYearMenu = options.some((o) => Number(lead(o.value) || lead(words(o))) > 12);
    let kind = field === "cc-exp-year" ? "year" : "month";
    let want = value;
    if (field === "cc-exp") {
      const parts = value.split("/");
      if (parts.length !== 2) return false;
      kind = isYearMenu ? "year" : "month";
      want = kind === "year" ? "20" + parts[1].slice(-2) : parts[0];
    }
    const n = Number(want);
    if (!Number.isInteger(n) || n < 1) return false;
    const hit = (s) => {
      const text = String(s).trim();
      const d = lead(text);
      if (d !== "") return kind === "year" ? Number(d) === n || (d.length === 2 && Number(d) === n % 100) : Number(d) === n;
      return kind === "month" && n <= 12 && text.toLowerCase().startsWith(names[n - 1]);
    };
    const option = options.find((o) => hit(o.value)) || options.find((o) => hit(words(o)));
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}
