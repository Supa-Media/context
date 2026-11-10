/**
 * The built-in page templates: a page whose shape is already decided (which
 * parts, in which order, where a drawing goes), with gaps for the facts.
 *
 * Owner, 2026-11-10: pages "were supposed to have templates". An agent picks
 * one from the ask, reads it (`orient about: "template <name>"`), and fills it,
 * so it decides the facts and not the layout. A person's own templates come
 * first: `tex/templates/` in their personal workspace and `templates/` in a
 * shared one, written there when they ask Tex to "keep this as a template".
 *
 * Every gap is `[in brackets]` and every unknown number `?`, except where a
 * block needs a number to draw (a `prices` group size, a `progress` share, a
 * `chart` value), which holds a 0 to replace. So a template is a page that
 * draws (each one is checked to: `pageTemplates.test.mjs`), and a filled page
 * with a bracket left in it is plainly unfinished.
 * Decision: `docs/decisions/app-and-console/pages.md`, "Pages start from a template".
 */

"use strict";

/** The stamp's place in a template's front matter; the gateway puts the current stamp in when it hands one out. */
const STAMP = "{stamp}";

const TEMPLATES = [
  {
    name: "decision",
    title: "Decision",
    use: "a choice someone has to make: your pick first, then the options, prices and a vote",
    source: `---
skill: ${STAMP}
kind: research
for: [who decides]
status: [one line: where the decision stands]
---

# [The pick, as the outcome: "The Stand, for $2,850"]

[One sentence: what this decides, the pick and the numbers that settle it.]

\`\`\`vote [Your pick in a few words]
action: Go with {pick}
- [Option one] | [one line of why]
- [Option two] | [one line of why]
- [Option three] | [one line of why]
\`\`\`

\`\`\`stats
- [Budget]: ? | [note]
- [People]: ? | [note]
- [Deadline]: ? | [note]
\`\`\`

## [What each option costs, as an answer: "From $420 to $2,850"]

[One sentence.]

\`\`\`prices What each one costs
per: [guest]
for: 0
- [Option one]: ? | [what you get]
  source: [the page you read it on]
- [Option two]: ? | [what you get]
  source: [the page you read it on]
\`\`\`

## [How it fits, as an answer]

[One sentence on how the pick works out in practice.]

\`\`\`drawing [How the pick fits together]
<rect x="140" y="320" width="320" height="200" fill="paper"/>
<text x="300" y="430">[part]</text>
<line x1="460" y1="420" x2="740" y2="420"/>
<rect x="740" y="320" width="320" height="200" fill="hatch"/>
<text x="900" y="430">[part]</text>
\`\`\`

## Next

- [ ] [The first thing to do once it's decided]
- [ ] [The second]
`,
  },
  {
    name: "research",
    title: "Research brief",
    use: "a question answered: the answer, the evidence and its limits, and the sources",
    source: `---
skill: ${STAMP}
kind: research
for: [who asked]
status: [one line: how sure the answer is]
---

# [The answer in a few words]

[One sentence: the question and its answer, with the number that matters most.]

\`\`\`stats
- [The key number]: ? | [what it measures]
- [The second]: ? | [what it measures]
\`\`\`

## [The first finding, as an answer]

[Two or three sentences of evidence, each fact with where it came from.]

## [The second finding, as an answer]

[Two or three sentences.]

\`\`\`versus [Two things the evidence compares]
a: [First]
b: [Second]
- [Measure]: ? | ?
- [Measure]: ? | ?
\`\`\`

## What this doesn't settle

> [!NOTE]
> [What the evidence can't tell you yet, and what would.]

## Sources

- [Title](https://[the page you read]): [what it showed]
`,
  },
  {
    name: "plan",
    title: "Plan",
    use: "how something gets done: the steps or a timeline, who owns each, and by when",
    source: `---
skill: ${STAMP}
kind: plan
for: [who it is for]
status: [one line: "Starts Monday", "On track"]
---

# [The outcome, done: "Sunday services, sorted"]

[One sentence: what this plan delivers, by when, for how many.]

\`\`\`stats
- [Budget]: ? | [note]
- [People]: ? | [note]
- [Date]: ? | [note]
\`\`\`

## [When it happens, as an answer]

\`\`\`timeline
- [Date]: [milestone] | [detail]
  state: now
- [Date]: [milestone] | [detail]
- [Date]: [milestone] | [detail]
\`\`\`

## [Who does what, as an answer]

\`\`\`board
- To do: [task] | [who]
- Doing: [task] | [who]
- Done: [task] | [who]
\`\`\`

## [How it flows, as an answer]

\`\`\`drawing [How the pieces hand off]
<circle cx="260" cy="420" r="90" fill="paper"/>
<text x="260" y="430">[step]</text>
<path d="M350 420 L 520 420"/>
<circle cx="610" cy="420" r="90" fill="paper"/>
<text x="610" y="430">[step]</text>
<path d="M700 420 L 870 420"/>
<circle cx="960" cy="420" r="90" fill="hatch"/>
<text x="960" y="430">[done]</text>
\`\`\`

## Next

- [ ] [The first step, with who]
- [ ] [The second]

\`\`\`contacts Who to call
- [Name]: [role] | [note]
  phone: ?
\`\`\`
`,
  },
  {
    name: "status",
    title: "Status",
    use: "where something stands: one big number against its goal, what moved, what's stuck",
    source: `---
skill: ${STAMP}
kind: status
for: [who follows it]
status: [one line: "On track", "Behind by a week"]
number: ? of ?
updated: [date]
---

# [Where it stands, in a few words]

[One sentence: the number, the goal, and what changed since last time.]

\`\`\`progress
- [Part one]: 0/1 | [note]
- [Part two]: 0/1 | [note]
\`\`\`

## [What moved, as an answer]

\`\`\`chart [The number over time]
type: line
- [Week 1]: 0
- [Week 2]: 0
- [Week 3]: 0
\`\`\`

## [What's stuck, as an answer]

- [What is stuck, and what would unstick it]

## Next

- [ ] [The next thing, with who]
`,
  },
  {
    name: "review",
    title: "Review",
    use: "a close look at something: numbered findings, each with what shows it, and what to fix first",
    source: `---
skill: ${STAMP}
kind: research
kicker: Review
for: [who it is for]
status: [one line: the verdict]
---

# [The verdict in a few words]

[One sentence: what was looked at, how, and the finding that matters most.]

\`\`\`stats
- Findings: ? | [how many are serious]
- [Looked at]: ? | [what and how much]
\`\`\`

## 1. [The first finding, as a claim]

[Two sentences: what you saw and why it matters.]

![What shows it](exhibit-1.png)

## 2. [The second finding, as a claim]

[Two sentences.]

![What shows it](exhibit-2.png)

## 3. [The third finding, as a claim]

[Two sentences.]

## Fix first

- [ ] [The fix that matters most]
- [ ] [The next]
`,
  },
  {
    name: "trip",
    title: "Trip or event",
    use: "a trip, a night out or an event: the places with photos, the day by day, and the map",
    source: `---
skill: ${STAMP}
kind: plan
for: [who is going]
status: [one line: "Nothing booked yet"]
---

# [The trip or event, as the outcome: "Two days in Philly, $310 each"]

[One sentence: when, where, how many, and the total.]

\`\`\`stats
- People: ? | [note]
- Each: ? | [what it covers]
- Dates: ? | [note]
\`\`\`

## [Where to stay or go, as an answer]

\`\`\`places [Places that fit]
near: [the town]
need: [? seats, or a room for ?]
- [Place]: [street address] | [why it fits]
  price: ?
  source: [the page you read it on]
- [Place]: [street address] | [why it fits]
  price: ?
  source: [the page you read it on]
\`\`\`

## [The day, as an answer]

\`\`\`itinerary [Day one]
- [7:00]: [stop] | [detail]
  walk: [? min]
- [9:00]: [stop] | [detail]
\`\`\`

## Next

- [ ] [Book the first thing]
`,
  },
];

const BY_NAME = new Map(TEMPLATES.map((template) => [template.name, template]));

/** One template's source with the stamp in it, or null for a name that isn't one. */
function templateSource(name, stamp) {
  const template = BY_NAME.get(String(name ?? "").trim().toLowerCase());
  return template ? template.source.replace(STAMP, stamp) : null;
}

/** The list the page skill shows: one line per template. */
function templateLines() {
  return TEMPLATES.map((template) => `- \`${template.name}\` (${template.title}): ${template.use}`);
}

module.exports = { TEMPLATES, templateSource, templateLines };
