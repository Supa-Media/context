# The apex's crawler surface

### Search and answer engines are recognised by name, and only real pages are offered to them (2026-11-26)

**Decision.** `infra/router` names the AI search and answer crawlers outright
(`OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`, `Perplexity-User`,
`Claude-SearchBot`, `Claude-User`) in `preview/crawlers.ts`, because their
published User-Agents carry a full desktop Chrome string and the generic
`…bot` fallback is suppressed for anything that looks like a browser. The
sitemap (`publicPages.ts`) lists only addresses that answer Googlebot with a
200, self-canonical page that is not `noindex`, and a test fetches every entry
to hold it to that. `robots.txt` carries the training-crawler denials itself
rather than relying on Cloudflare's managed robots.txt toggle.

A crawler asking for an address that is not a page no longer gets the sign-in
card with `/` as its canonical (a soft 404 pointing everything at the
homepage): `/privacy` and `/terms` move to their complete static documents
(`apps/mobile/public/legal/`, generated from `features/legal/content.ts`), a
bare address the homepage website may own is that page's own card or a real
404, and `/connect` is a 404. Console and name-bearing addresses keep the
frozen card and still ask nobody.

**What a "simplification" would cost.** Folding the AI crawlers back into the
generic rule serves them the Expo shell, which is an empty page to a reader
that runs no JavaScript. Answering a bare address with the frozen card again
tells search engines every such address is the homepage. Treating a control
plane that cannot be asked as "no page" would 404 a live page to Googlebot on
a blip; that case is a 503 with `Retry-After`.

**The one upstream call this adds.** A bare top-level address asks
`/site/preview` whether *Context's own* homepage website (the fixed
`HOME_SITE_HANDLE`) has a page there. No name the crawler typed reaches the
control plane as a workspace name; `worker.test.ts` pins the request body.

**Tests.** `src/publicPages.test.ts`, `src/icons.test.ts` (robots),
`src/preview/crawlersAndCards.test.ts` (User-Agents),
`scripts/public-privacy.test.mjs` (legal documents).
