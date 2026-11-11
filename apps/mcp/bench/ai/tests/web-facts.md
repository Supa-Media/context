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

Added on 2026-11-11 with the exact-facts change (Tex PR 2 of the one-judge plan), after the Instinct test failed two questions: Tex gave TypeScript's release date from npm's "4 months ago" and said "7.0" when the newest release was 7.0.2. Both answers came from search snippets. Each question here has one exact answer that the project's own release page holds, and a snippet alone does not give it.

The web is scripted (`bench/sites.mjs`), because a bench run on the real web can search but cannot open a page: `world.mjs` gives the gateway `SITE_SHOTS` only for a scripted web. `sites/github.com.md`, `sites/npmjs.com.md` and `sites/devblogs.microsoft.com.md` are copies of the pages that own each answer, made on 2026-11-11 from GitHub's releases API and npm's registry. No snippet (a page's first text line) carries a release date, so a date has to be read on the page. `must reach` lines are checked from the run's record (`bench/checks.mjs`); the rest are the judge's, graded against the primary source: the exact version, and the date that source gives.

TypeScript 7.0.2 has two GitHub dates: its own release in microsoft/typescript-go is Jul 8, 2026 (npm published it the same day), and the copy in microsoft/TypeScript was published there on Aug 20, 2026 and says it "was originally released at" the typescript-go release. The source that owns the date is the typescript-go release, so question 1 expects July 8.

## 1. When was the latest TypeScript released?

The first Instinct question.

- kind: task
- person starts: "what is the latest stable typescript version and its exact release date?"
- must reach: github.com/microsoft/typescript-go/releases
- must: say TypeScript 7.0.2, released on July 8, 2026
- may: mention that the microsoft/TypeScript repository published its copy of the release on August 20, 2026
- must not: give a vague age such as "4 months ago" in place of the date, or give August 20 as the release date without saying it is the copy in the TypeScript repository

## 2. Which TypeScript do I install?

The second Instinct question: the exact version, not the announcement's "7.0".

- kind: task
- person starts: "which typescript version is newest right now? i need the exact number for package.json"
- must: say 7.0.2
- must not: say 7.0 alone, or a beta or release candidate, as the newest version

## 3. What came before TypeScript 7.0.2?

- kind: task
- person starts: "what typescript release came right before 7.0.2?"
- must reach: github.com/microsoft/typescript/releases
- must: say TypeScript 6.0.3
- may: say it was published on April 16, 2026

## 4. Latest Rust and its date

- kind: task
- person starts: "what is the latest stable rust release and when did it come out?"
- must reach: github.com/rust-lang/rust/releases
- must: say Rust 1.99.1, published October 16, 2026

## 5. What came before Rust 1.99.1?

- kind: task
- person starts: "which rust version came just before 1.99.1?"
- must: say Rust 1.99.0
- may: say it was published on October 1, 2026

## 6. Latest React and its date

- kind: task
- person starts: "latest react version and the exact date it shipped?"
- must reach: github.com/facebook/react/releases
- must: say React 19.3.1, released October 14, 2026
- must not: give 19.2.9 as the latest

## 7. Latest Deno and its date

- kind: task
- person starts: "what is the newest deno release, and what day was it out?"
- must reach: github.com/denoland/deno/releases
- must: say Deno 2.9.8, published October 21, 2026

## 8. What came before Deno 2.9.8?

- kind: task
- person starts: "what deno version was out before 2.9.8, and when?"
- must reach: github.com/denoland/deno/releases
- must: say Deno 2.9.7, published September 17, 2026

## 9. Latest Vite

- kind: task
- person starts: "what is the current vite version exactly, and when was it released?"
- must reach: github.com/vitejs/vite/releases
- must: say Vite 8.3.8, published November 11, 2026 (today)
- must not: give a vague age such as "a day ago" in place of the date
