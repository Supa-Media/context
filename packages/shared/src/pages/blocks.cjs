/**
 * The block kinds a page draws, what each one's lines mean, and the checks a
 * block has to pass.
 *
 * A block is a fence named for its kind, an optional caption after the name,
 * then one item per `- ` line and settings as `key: value` lines:
 *
 *     ```compare Quotes per head
 *     limit: 35
 *     - Casa Lola: $29 | Family style, staff included
 *     - Marlow's: $41 | Over budget
 *     ```
 *
 * An item is `|`-separated parts, and its first part may start with a
 * `Label: `. What the label and each part mean is the kind's (`about` below,
 * which is also what Tex is told). These are Tex's card templates
 * (`apps/mcp/src/agent/visuals/`) as page blocks: the same set of things a
 * person is shown, written as data the page draws, so every word in them stays
 * a word in the note.
 *
 * The checks are for the writer, not for safety: the runtime draws whatever it
 * is given and escapes every word. They stop the gateway saving a block an
 * agent got wrong (a chart with no numbers, a choice of one), with a sentence
 * that says how to fix it.
 */

/** A number in a value like "$1,250", "33", "1.2s" or "-4%", or null. */
function numberIn(value) {
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(String(value ?? ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "3/5", "60%" or "0.6" as a share from 0 to 1, or null. */
function shareIn(value) {
  const text = String(value ?? "");
  const of = /(-?\d[\d,]*(?:\.\d+)?)\s*(?:\/|of)\s*(\d[\d,]*(?:\.\d+)?)/.exec(text);
  if (of) {
    const total = Number(of[2].replace(/,/g, ""));
    return total > 0 ? Math.min(1, Math.max(0, Number(of[1].replace(/,/g, "")) / total)) : null;
  }
  const pct = /(-?\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) return Math.min(1, Math.max(0, Number(pct[1]) / 100));
  const n = numberIn(text);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

/** An item's field by any of its names (`photo`, `photos`), or null. */
function fieldOf(item, ...keys) {
  return (item.fields ?? []).find((field) => keys.includes(field.key)) ?? null;
}

/** "Ask", "?", "TBD", "not listed": a price the writer does not know, drawn as one to ask for. */
const UNKNOWN = /^\s*(\?|ask\b.*|tbd|unknown|not (?:listed|published)|by (?:email|phone|quote))\s*$/i;

/** A seat count or range ("300-500", "225") as its top number, or null. */
function seatsIn(value) {
  const nums = String(value ?? "").match(/\d[\d,]*/g);
  return nums ? Math.max(...nums.map((n) => Number(n.replace(/,/g, "")))) : null;
}

const optionsCheck = (block, least, most) => [
  ...(block.items.length < least ? [`Give at least ${least} options.`] : []),
  ...(block.items.length > most ? [`At most ${most} options; put the rest in a places or prices block.`] : []),
];

const labelled = (block, what) =>
  block.items.filter((item) => item.label === null).map((item) => `"${item.parts[0].text.slice(0, 40)}" needs a label first: "- ${what}: ...".`);

/**
 * Each kind: what it is for and how its lines read (told to Tex and to people
 * in the format guide), its settings, and its check.
 */
const BLOCK_KINDS = {
  stats: {
    about: "headline numbers, big, on hairlines. - Label: value | note (up to 6)",
    settings: [],
    check: (block) => [...labelled(block, "Budget"), ...(block.items.length > 6 ? ["A stats row holds at most 6 numbers."] : [])],
  },
  compare: {
    about:
      "options ranked on one number, as bars against an optional limit (quotes, prices, times). - Name: value | note. Settings: limit (a number), unit ('per head'), better (lower|higher, default lower), pick (the name to mark)",
    settings: ["limit", "unit", "better", "pick"],
    check: (block) => [
      ...labelled(block, "Casa Lola"),
      ...block.items.filter((item) => item.label && numberIn(item.parts[0].text) === null).map((item) => `${item.label.text} needs a number to compare.`),
      ...(block.settings.limit && numberIn(block.settings.limit.value) === null ? ["limit: needs a number."] : []),
      ...(block.settings.better && !/^(lower|higher)$/i.test(block.settings.better.value) ? ["better: is lower or higher."] : []),
      ...(block.items.length < 2 ? ["Compare at least two things."] : []),
    ],
  },
  chart: {
    about: "numbers over time or by category. - Label: number | note. Settings: type (bar|line, default bar), unit, goal (a number drawn as a line)",
    settings: ["type", "unit", "goal"],
    check: (block) => [
      ...labelled(block, "Week 1"),
      ...block.items.filter((item) => item.label && numberIn(item.parts[0].text) === null).map((item) => `${item.label.text} needs a number.`),
      ...(block.settings.type && !/^(bar|line)$/i.test(block.settings.type.value) ? ["type: is bar or line."] : []),
      ...(block.items.length < 2 ? ["A chart needs at least two numbers."] : []),
    ],
  },
  progress: {
    about: "how far along things are. - Label: 3/5 (or 60%) | note",
    settings: [],
    check: (block) => [
      ...labelled(block, "Invites sent"),
      ...block.items.filter((item) => item.label && shareIn(item.parts[0].text) === null).map((item) => `${item.label.text} needs a share like 3/5 or 60%.`),
    ],
  },
  timeline: {
    about: "things in time order: deadlines, milestones. - When: what | detail. Field: state (done or now)",
    settings: [],
    check: (block) => labelled(block, "Sat 9:00"),
  },
  steps: {
    about: "how to do something, numbered. - Step | detail",
    settings: [],
    check: () => [],
  },
  choose: {
    about:
      "options the reader picks from by tapping; their pick is written back as chosen: and you read it next time. - Option | detail. Setting: chosen (empty until they pick)",
    settings: ["chosen"],
    check: (block) => (block.items.length < 2 ? ["A choice needs at least two options."] : []),
  },
  board: {
    about: "work by status, as lanes. - Column: card | who (e.g. - Doing: Book the van | Zay)",
    settings: [],
    check: (block) => labelled(block, "Doing"),
  },
  people: {
    about: "who is involved. - Name: role | note",
    settings: [],
    check: (block) => labelled(block, "Zay"),
  },
  places: {
    about:
      "places to go, each a spread with photos, a price, how many it holds against what you need, and a fact strip. - Name: street address | why it fits. " +
      "Fields, indented under it: price ($2,850, or Ask), seats (300-500), photo or photos (file names; filled for you when left out), and any facts as `key: yes|no|?|words` (kitchen: yes; on the L: no). " +
      "Settings: near (the town), need (\"200 seats\", drawn against each seats), map (filled for you)",
    settings: ["near", "need", "map"],
    check: (block) => labelled(block, "Casa Lola"),
  },
  vote: {
    words: true,
    about:
      "your pick, and the options people vote on, in one dark card: the caption is the pick in a few words, the line under it is why, then one option per line. " +
      "- Option | detail. Fields: photo, votes (names who picked it). Settings: action (the button, with {pick}: \"Ask {pick} for a quote\"), chosen (empty until someone decides), voters (how many are voting). Put it right after the opening words",
    settings: ["action", "chosen", "voters"],
    check: (block) => [
      ...optionsCheck(block, 2, 6),
      ...(block.title ? [] : ['vote needs your pick as its caption: "```vote Ask The Stand first".']),
    ],
  },
  prices: {
    about:
      "prices on one shared axis, so the gap is visible, with a total for the group. - Name: $14 | what you get (? or Ask when not listed). Fields: photo. Settings: per (guest), for (30, the group size for totals), pick (the name to mark)",
    settings: ["per", "for", "pick"],
    check: (block) => [
      ...labelled(block, "Smart Value"),
      ...block.items
        .filter((item) => item.label && numberIn(item.parts[0].text) === null && !UNKNOWN.test(item.parts[0].text))
        .map((item) => `${item.label.text} needs a price, or ? when it is not listed.`),
      ...(block.items.length < 2 ? ["Show at least two prices."] : []),
      ...(block.settings.for && numberIn(block.settings.for.value) === null ? ["for: needs a number of people."] : []),
    ],
  },
  itinerary: {
    about: "a day or a night as stops with photos and the walk between them. - 7:00: Dinner at the grill house | Table for 8. Fields: photo, walk (to the next stop: \"6 min · 0.3 mi\")",
    settings: [],
    check: (block) => labelled(block, "7:00"),
  },
  tiers: {
    about:
      "two to four budgets side by side, each with what it buys. - Good: $85 | a head. Fields: photos, votes, and each thing it buys as `Korean BBQ: $48`. Settings: pick (your pick), chosen (empty until someone decides)",
    settings: ["pick", "chosen"],
    check: (block) => [...labelled(block, "Good"), ...optionsCheck(block, 2, 4)],
  },
  contacts: {
    about: "who to call or write, with buttons. - Name: role | note. Fields: phone, email, text (a number to text), site",
    settings: [],
    check: (block) => [
      ...labelled(block, "Smart Value"),
      ...block.items
        .filter((item) => !fieldOf(item, "phone", "email", "text", "site"))
        .map((item) => `${item.label ? item.label.text : "A contact"} needs a phone:, email:, text: or site: field under it.`),
    ],
  },
  versus: {
    about: "two things side by side, row by row. Settings: a, b (their names). - Row: a's value | b's value",
    settings: ["a", "b", "better"],
    check: (block) => [
      ...(block.settings.a && block.settings.b ? [] : ["versus needs a: and b: naming the two things."]),
      ...labelled(block, "Price"),
      ...block.items.filter((item) => item.parts.length < 2).map((item) => `${item.label ? item.label.text : "A row"} needs both values: "- Row: a | b".`),
    ],
  },
};

/** The problems with one parsed block, as sentences; empty when it is fine. */
function checkBlock(block) {
  const kind = BLOCK_KINDS[block.kind];
  if (!kind) return [];
  const problems = [];
  if (block.items.length === 0) problems.push(`The ${block.kind} block has no items ("- ..." lines).`);
  for (const key of Object.keys(block.settings)) {
    if (!kind.settings.includes(key)) {
      problems.push(`${block.kind} has no setting "${key}"${kind.settings.length ? ` (it takes ${kind.settings.join(", ")})` : ""}.`);
    }
  }
  return [...problems, ...kind.check(block)].map((problem) => `${block.kind}${block.title ? ` "${block.title}"` : ""}: ${problem}`);
}

module.exports = { BLOCK_KINDS, checkBlock, numberIn, shareIn, fieldOf, seatsIn, UNKNOWN };
