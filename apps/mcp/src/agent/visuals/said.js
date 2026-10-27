/**
 * WHAT A DRAWN CARD SAID, IN WORDS.
 *
 * A card is a picture, and the saved conversation keeps only words. With no
 * more than its title kept, Tex's next turn and the self-review judge
 * (`../selfReview.js`) saw "[Sent a picture]" and read a card of four
 * restaurants as an answer that hid the options (triage, 2026-10-26). So the
 * line kept for a sent card carries what it showed: each option's name and
 * the facts beside it, taken from the data it was drawn from.
 */

/** The most characters one card's words take in the saved conversation. */
export const MAX_CARD_WORDS = 500;

/** Fields shown beside an item's name, in the order a person reads them. */
const ITEM_FACTS = ["cuisine", "price", "price_note", "display", "hours", "address", "distance", "duration", "stops", "source", "role", "status", "when", "note", "tag"];

const words = (value) => (typeof value === "string" || typeof value === "number" ? String(value).replace(/[\s\[\]]+/g, " ").trim() : "");

/** One item, as its name and what the card showed beside it. */
function item(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return words(entry);
  const name = words(entry.name ?? entry.title ?? entry.what ?? entry.label);
  const facts = ITEM_FACTS.map((key) => words(entry[key])).filter(Boolean);
  if (entry.depart || entry.arrive) facts.unshift([words(entry.depart), words(entry.arrive)].filter(Boolean).join(" to "));
  if (entry.start) facts.unshift([words(entry.start), words(entry.end)].filter(Boolean).join(" to "));
  if (Array.isArray(entry.stops)) facts.push(entry.stops.map(item).filter(Boolean).join(", "));
  if (entry.pick === true) facts.push("Tex's pick");
  return facts.length > 0 ? `${name} (${facts.join(" · ")})` : name;
}

/** A card's words: its title, then each thing on it with its facts, cut to `MAX_CARD_WORDS`. */
export function cardWords(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const parts = [];
  // One option a card: the option itself is the card's subject.
  if (words(data.name)) parts.push(item({ ...data, facts: undefined }));
  else if (words(data.title) || words(data.kicker)) parts.push(words(data.title) || words(data.kicker));
  if (Array.isArray(data.facts)) parts.push(data.facts.map((fact) => [words(fact?.label), words(fact?.value)].filter(Boolean).join(": ")).filter(Boolean).join("; "));
  for (const key of ["items", "days", "events", "steps", "people", "rows", "columns"]) {
    if (!Array.isArray(data[key])) continue;
    const listed = data[key].map((entry) => (key === "rows" && entry && typeof entry === "object" ? `${words(entry.label)}: ${words(entry.a)} vs ${words(entry.b)}` : item(entry))).filter(Boolean);
    if (listed.length > 0) parts.push(listed.map((line, i) => `${i + 1}. ${line}`).join("; "));
  }
  const said = parts.filter(Boolean).join(" — ");
  return said.length > MAX_CARD_WORDS ? `${said.slice(0, MAX_CARD_WORDS - 1)}…` : said;
}
