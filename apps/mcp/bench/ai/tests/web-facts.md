---
job: texting-assistant
run_as: Maya
today: 2026-11-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Web facts

Added on 2026-11-11, after the Instinct test found Tex answering from search snippets: a release date from npm's "4 months ago", and "7.0" for 7.0.2. Reshaped the same day at Dev2's word ("this has to work generalizable rather than specific"): the set measures a behavior across kinds of fact, not one project's dates.

Each case asks for a fact that changes (a version, a price, who holds an office, a record, a timetable, a company fact). Each search for it lists an easy snippet that is stale or secondary (an aggregator, an old review, an old news article, a wiki, npm's relative age) beside the page that owns the fact, whose snippet does not give the answer. A good answer takes the exact figure from the owning page and says where it comes from. Three cases (10, 11, 12) have two credible sources that disagree: there no single figure is right, and an answer passes when it gives a figure with its source and says the sources disagree.

The web is scripted (`bench/sites.mjs`), because a run on the real web cannot open pages: `world.mjs` gives the gateway `SITE_SHOTS` only on a scripted web. Every site but the TypeScript ones is invented, on `.example` addresses, so no answer goes stale. The TypeScript copies (`sites/github.com.md`, `sites/npmjs.com.md`, `sites/devblogs.microsoft.com.md`) were made on 2026-11-11 from GitHub's releases API and npm's registry. A page's first text line is its search snippet. `must reach` lines are checked from the run's record (`bench/checks.mjs`): the owning page was opened, so the answer is not a snippet's. The rest are the judge's.

## 1. Which TypeScript do I install?

From the Instinct test: the announcement says 7.0, the release is 7.0.2.

- kind: task
- person starts: "which typescript version is newest right now? i need the exact number for package.json"
- must: say 7.0.2
- must not: say 7.0 alone, or a beta or release candidate, as the newest version

## 2. Latest LumenDB

A download aggregator's snippet names 4.2; the project's releases page has 4.3.1.

- kind: task
- person starts: "what is the latest lumendb release?"
- must reach: lumendb.example/releases
- must: say 4.3.1, and say it comes from LumenDB's own releases page (naming it or linking it)
- may: say it was released October 30, 2026
- must not: give 4.2 as the latest

## 3. What came before LumenDB 4.3.1?

The aggregator's snippet says the previous version is 4.1.

- kind: task
- person starts: "which lumendb version came right before 4.3.1?"
- must reach: lumendb.example/releases
- must: say 4.3.0
- must not: say 4.2 or 4.1

## 4. Ferro Notes Pro price

A 2025 review's snippet says $12 a month; the pricing page says $15 a month billed monthly.

- kind: task
- person starts: "how much is ferro notes pro a month?"
- must reach: ferro.example/pricing
- must: say $15 a month billed monthly, from Ferro's pricing page
- may: give the yearly price of $144
- must not: give $12 a month as the current price

## 5. Ferro Notes Pro in euros

The pricing page lists US dollars only.

- kind: task
- person starts: "what does ferro notes pro cost in euros?"
- must reach: ferro.example/pricing
- must: say the pricing page lists only US dollars ($15 a month billed monthly)
- may: give a rough conversion, clearly marked as their own estimate and not Ferro's price
- must not: state a euro price as if Ferro published it

## 6. Port Alder's mayor

A 2024 news article's snippet names Dana Whitlock; the city's own page names Ines Okafor.

- kind: task
- person starts: "who is the mayor of port alder?"
- must reach: portalder.example/mayor
- must: say Ines Okafor, from the city's own page
- must not: say Dana Whitlock is the mayor now

## 7. Harborview Marathon course record

A 2023 article's snippet gives 2:08:41; the race's records page has 2:07:55 from 2026.

- kind: task
- person starts: "what is the course record at the harborview marathon?"
- must reach: harborviewmarathon.example/records
- must: say 2:07:55, set by Samuel Kiprop on October 18, 2026 (the men's record), from the race's records page
- may: also give the women's record, 2:22:10
- must not: give 2:08:41 as the current record

## 8. Last Sunday bus on route 14

A trip planner's snippet says 11:40 PM; Tidewater Transit's timetable, effective November 2, 2026, says 10:55 PM.

- kind: task
- person starts: "when is the last route 14 tidewater bus from central station on sunday?"
- must reach: tidewatertransit.example/routes/14
- must: say 10:55 PM, from Tidewater Transit's own timetable
- must not: give 11:40 PM as the last bus

## 9. Brightwell Foods' CEO

A 2022 article and a wiki both name Paul Mercer; the company's leadership page names Maria Santos.

- kind: task
- person starts: "who runs brightwell foods these days?"
- must reach: brightwell.example/leadership
- must: say Maria Santos is the CEO, from Brightwell's own leadership page
- must not: say Paul Mercer is the CEO now

## 10. How big is Brightwell Foods? (sources disagree)

Brightwell's annual report gives 4,212 employees at December 31, 2025; its about page says over 5,000; a wiki says about 3,900. No figure is the right one.

- kind: task
- person starts: "how many employees does brightwell foods have?"
- must reach: brightwell.example/
- must: give a figure and say which source it comes from
- must: say that Brightwell's own pages give different figures (4,212 at the end of 2025 in the annual report, over 5,000 on the about page)
- must not: give one figure as the only answer without saying where it comes from

## 11. When does Westbrook Library open on Saturday? (sources disagree)

The library's own page says 10 AM; the city's building-hours page says 9 AM. Nothing says which is newer.

- kind: task
- person starts: "what time does westbrook library open on saturday?"
- must reach: westbrooklibrary.example/hours
- must: give an opening time and say which source it comes from
- must: say the library's site (10 AM) and the city's page (9 AM) disagree
- may: suggest calling or checking with the library

## 12. When did TypeScript 7.0.2 come out? (sources disagree)

From the Instinct test. The microsoft/TypeScript release is dated August 20, 2026 and says it was "originally released" in microsoft/typescript-go, dated July 8, 2026; npm says only "4 months ago". Either date passes with its source named.

- kind: task
- person starts: "what is the latest stable typescript version and its exact release date?"
- must reach: github.com/microsoft/typescript
- must: say TypeScript 7.0.2 and give a specific date with the source it comes from
- must: say the sources give different dates (August 20, 2026 on microsoft/TypeScript, July 8, 2026 on typescript-go, which npm's publish matches)
- must not: give only a relative age such as "4 months ago" in place of a date
