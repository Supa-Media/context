# CSP enforcement is tried in a browser before it ships

_Recorded 2026-10-29, during the CASA scan work on the `script-src` and
`style-src` `'unsafe-inline'` findings._

### The report-only policy is enforced against the browser specs before production

The router sends a script, style and fetch policy as
`Content-Security-Policy-Report-Only` (`infra/router/src/cspReport.ts`), and
its reports are logged by directive, blocked origin and document class, never
by path. Quiet reports are weak evidence that the policy can enforce. A report
only comes from a path somebody used, and the paths most likely to break are
the dynamic ones: a `<style>` filled by script on first use, a frame that
inherits the shell's policy, a library that builds a function from a string.

So enforcement is tried first against the existing browser specs, which
exercise those paths on purpose. With `E2E_CSP_CANDIDATE` set, the suite's
static server (`apps/mobile/e2e/webkit/static-server.mjs`) sends each document
the router's own headers. They are computed by calling the router
(`csp-candidate.ts`), so they cannot drift from it. On top of those headers,
the server enforces as much of the report-only policy as the mode asks for:

- `production`: nothing extra. These are the router's headers exactly.
- `script`: the report-only policy's `script-src`, and nothing else.
- `full`: every directive in the report-only policy.

The router's report-only policy still reports to `/_csp-report`; the
enforced copy reports to `/_csp-report/enforce`, and that address is how a
report's disposition is known. WebKit's legacy reports carry no
`disposition` for either policy, and in `full` mode the two policies are the
same text, so neither the body nor its `original-policy` can tell them apart.
A body whose own disposition contradicts its address, or a report with
neither, is logged "unknown" and fails the check; nothing assumes "enforce".
(Before this, a missing disposition was logged as "enforce", which
mislabelled WebKit's report-only style rows in the first CI run.)

The server keeps the same fields
the router does, with the same bounds (`csp-report-log.mjs`): a document class
from a fixed list, a directive of at most 40 lowercase letters and hyphens, an
origin or one of the keywords CSP reports, and the disposition. It is plain
Node, so it repeats the router's rules instead of importing them, and the
router suite's `cspReportFixtureParity.test.ts` keeps the two in step. That
test feeds both the same hostile reports (paths, queries, tokens, script
samples, non-string fields, all-letter "keywords") and fails if the directive
or blocked source differ, or if any of that text reaches a line. Changing the
fixture module runs the router tests. `csp-candidate-check.mjs` prints the counts. It fails if a
directive it guards has an enforced violation, if no readable report arrived
at all, or if any row cannot be read: an "unknown" directive or disposition,
a missing field, a line that is not JSON. An unreadable row is never dropped
and never counts as the evidence that reporting works, since a run made only
of those would otherwise pass while saying nothing. Its self-test
(`csp-candidate-check.selftest.mjs`) runs first in the job.

**The script half runs in CI.** The `Script policy enforced in WebKit` job in
`browser.yml` runs in `script` mode. It covers the note editor, drawing,
diagram and html preview specs per push, whenever the browser fixture's scope
is affected. The router's three policy files are now part of that scope. The
plugin panel specs join once a day, when the community releases are fetched;
that keeps "per push, a real browser tests only the note editor"
([ci-pipelines](./ci-pipelines.md)). The sandbox's own two specs fulfil every
request themselves and never see these headers. The specs have to pass, and the log must hold no enforced
`script-src` violation. Both checks are needed: when the shell's appearance
script was sabotaged (its hash changed), the smoke spec stayed green and only
the log check failed.

### What the first runs showed (Chromium, 2026-10-29)

These are local runs against the E2E export, in the agent sandbox's Chromium.
That is not a WebKit result; the CI job provides that. Counts are passed /
failed, and "baseline" is a failure the plain server (no policy at all) has
too: `editorFormatting.spec.ts`, "a click on a web link opens it in a new
tab", which fails in this sandbox whatever the headers are. It is counted as
a failure in every column, not as a pass.

| Specs | No policy (plain server) | `script` | `full` |
| --- | --- | --- | --- |
| Editor (6 files, 36 cases) | 35 / 1 (baseline) | 35 / 1 (baseline); 0 script violations | 33 / 3 (baseline, plus `comments.spec.ts` and `pasting.spec.ts` "far down a note keeps the page where it is") |
| Drawing, diagram, html preview (3 files, 10 cases) | 10 / 0 | 10 / 0; 0 script violations | 8 / 2 (`drawingFonts.spec.ts`, `htmlPreview.spec.ts` "renders as a diagram") |
| Plugins (8 files, 17 cases, real bundles fetched; the two sandbox specs fulfil their own requests) | 17 / 0 | 17 / 0; 0 script violations | 17 / 0; 2 shell style violations |

So `script` adds no failure over the plain server, and `full` adds four.

In `full` mode, every violation is a style or font one:

1. **The note editor's own styles (shell, `style-src-elem`).** CodeMirror's
   `style-mod` mounts its themes into a `<style>` element whose text it
   writes. It uses an adopted stylesheet only for a shadow root, never for a
   `Document` (`style-mod/src/style-mod.js`: `!root.head &&
   root.adoptedStyleSheets`). Blocked, the editor loses its layout rules, and
   the two scroll-position cases fail. This is the one shell violation the
   suites found, and they found it in every spec that opens a note. The fix
   is either a nonce per response, which the router would have to write into
   the static shell, or mounting the editor in a shadow root. The nonce is
   tried below, in [A style nonce per shell response](#a-style-nonce-per-shell-response-proposed-2026-10-29).
2. **The html preview fence (`srcdoc` frame, `style-src-elem`).**
   `livePreview/htmlPreview.ts` renders the author's HTML in a
   `sandbox=""` `srcdoc` frame, and a `srcdoc` document inherits the shell's
   policy. The author's own `<style>` is blocked, so the diagram draws
   unstyled. This needs the same move the plugin sandbox made (#2437): a page
   of its own, by URL, with a policy of its own.
3. **The diagram renderer (`/drawing-assets/diagram/`, `style-src-elem` and
   `style-src-attr`).** Its `frame.js` writes inline styles and style
   attributes into the SVG it draws. The router gives that page the shell's
   policy. `mermaid.spec.ts` still passes, because it checks structure, not
   paint. The page needs a style policy of its own, the way the drawing
   editor has one.
   **Given one (2026-10-29):** the router now reports the diagram page
   against `DIAGRAM_POLICY` (`infra/router/src/cspReport.ts`), the policy
   its own `<meta>` already enforces: `default-src 'none'`, `script-src
   'self'`, `style-src 'unsafe-inline'`, `img-src data:`. Inline style is
   allowed on this one document only. It runs in an opaque origin
   (`sandbox="allow-scripts"`), and with no fetch, font, frame or remote
   picture allowed, a style cannot carry anything out. Its script half is
   narrower than the shell's. `cspReport.test.ts` holds the header to the
   meta that the build writes, and checks that no platform page but this
   one allows inline style. `cspDiagramStyle.spec.ts` runs in WebKit over
   HTTPS with the whole candidate enforced and the shell nonced:
   - Mermaid's node fill applies, and the diagram frame refuses nothing.
   - Opened on its own, the page refuses a remote picture, an inline
     script, a stylesheet by URL and a fetch, each enforced and reported.
   - It still allows an inline style and a `data:` picture.
   - Sending the diagram the shell's policy fails all three checks.
   The production enforced header is unchanged.
4. **The drawing editor's font fallbacks (`font-src`, esm.sh).** Excalidraw
   lists an esm.sh URL after ours for every face. Under report-only, the
   browser reports those URLs but fetches nothing. Enforced, each one becomes
   a request that fails with `csp` before it leaves the browser. The fonts
   still load from our origin. `drawingFonts.spec.ts` counts every off-origin
   request event, blocked ones included, so it fails. Nothing reaches esm.sh,
   but the guard cannot tell that, and it should not be loosened to tell it
   until `font-src` is the directive being moved.
   **Fixed at the source (2026-10-29):** the build now removes the one
   statement that pushes the esm.sh URL (`scripts/excalidraw-font-fallback.mjs`,
   an esbuild plugin that fails the build unless it matches exactly once), so
   every face lists our file only. A face we do not deploy (`Xiaolai`) falls
   back to a system font, as `drawingAssets.ts` already says, instead of
   asking esm.sh. No policy changes and the guard stays as strict.

### What the first WebKit run showed (CI, 2026-10-29, head f34694d6)

`script` mode, per-push specs: 43 passed, 3 failed. All three failures are
`mermaid.spec.ts`: the diagram's SVG never appeared, on the first attempt and
the retry. The trace shows WebKit refusing `/drawing-assets/diagram/frame.js`
under the enforcing `script-src`, alongside a `[Report Only]` duplicate of
the same refusal. Chromium ran the same frame under the same policy. So the
two logged `script-src-elem` rows for that document are one enforced refusal
plus its report-only duplicate, not two independent refusals.

The diagram frame is `sandbox="allow-scripts"` without `allow-same-origin`,
so its document has an opaque origin, and it loads `frame.js` from its own
path under `'self'`. The first explanation was that WebKit matches `'self'`
in a header policy against that opaque origin. The second WebKit run (head
f595426d) disproved it: `cspOpaqueSelf.spec.ts` ran its script in all four
frames there (header `'self'`, meta `'self'`, header `'self'` plus the origin,
and unsandboxed). So naming the origin explicitly is not the fix, and is not
made. The same run's log, with dispositions now known by address, held one
enforced and one report-only `script-src-elem` row for the diagram, and the
five style rows were all report-only.

`cspDiagramFrame.spec.ts` narrows it further. It rebuilds the real frame one
difference at a time, as `livePreview/diagram.ts` makes it: header set (none,
bare `'self'`, the candidate's enforced copy alone, every header the
candidate sends, production's alone), origin, page (minimal or the shipped
`index.html` with its meta policy) and script (a marker or the shipped
`frame.js`). Then it bridges back with the shipped page from the fixture's
own server, unrouted. The job runs `mermaid.spec.ts` from the plain server
(no headers) and the diagram specs under `production` mode before the
candidate, so a failure the candidate causes is told apart from one the
fixture already has.

The first WebKit run of it (head 521be076, job 123373317020) split on origin.
At `https://context.test` all 16 frames ran. At the fixture's
`http://127.0.0.1:4874` 14 of 16 were blocked. The two that ran were the
minimal page under production's headers, the only frames with no enforcing
`'self'` at all. The block was the same under `production` mode as under
`script`, and `mermaid.spec.ts` failed under production's headers too. So the
refusal follows the fixture's plain-HTTP, IP-address origin. It is not the
candidate, and nothing shows it in an HTTPS deployment. The next run (head 12be7a27, job 123377644693) separated scheme from host,
and the scheme decides. At `https://127.0.0.1:4874` all 20 frames ran, and at
`http://context.test` 16 of 20 were blocked, the same as at the fixture's
`http://127.0.0.1:4874`. The blocked frames are exactly those that enforce a
`'self'`, whether by header or by the page's own meta policy. The four that
ran enforce none. `mermaid.spec.ts` failed in WebKit from the plain fixture
server too, with no headers at all, so the shipped page's own meta policy is
enough to refuse its script on plain HTTP. The diagram renderer has never
been tested working in WebKit by this fixture, candidate or not.

So the candidate job runs over HTTPS (`E2E_HTTPS=1`), as production does.
This changes the test transport, not which tests run. The Playwright config
makes a throwaway self-signed certificate for the run, the static server
answers over HTTPS on its own port, and only these browsers, in those steps,
skip the certificate check. Each mode and transport writes its report log to
its own directory (`csp-candidate/<mode>-<http|https>/`), so one run never
resets another's. The job runs:

1. Under `production`: `mermaid.spec.ts`, the diagnostics and the probe
   below, then the log check.
2. Under `script`: the whole per-push list (`mermaid.spec.ts` included, the
   plugin specs daily), the diagnostics and the probe, then the log check.

The plain-HTTP behaviour stays in the suite as asserted controls, not as a
red step. `cspDiagramFrame.spec.ts` routes its frames itself, so it tests
both schemes whatever the transport, and holds exactly what each engine
does. In WebKit, on an HTTP origin, the frames that enforce a `'self'` are
blocked and no others; everywhere else nothing is blocked. A change either
way fails. The first all-HTTPS run (head 1bb968ca, job 123386789761) had the
production step at 9 passed with no enforced script violation. The script
step had 51 passed and 1 flaky (`comments.spec.ts`, which also flakes
without any policy), with no enforced script violation in 445 reports. The
same run's plain-HTTP step passed its 53 specs, but logged 6 enforced
diagram `script-src-elem` refusals from notes that draw a diagram in passing.
That is the HTTP limitation again, and the reason the transport moved.

`cspNegativeProbe.spec.ts` proves enforcement in the browser, not just in the
checker. It loads a shell path from the fixture's own server, keeps that
response's exact headers, and swaps the body for one inline script no policy
allows. Under `script` or `full` the script must not run, and exactly one
enforced and one report-only `script-src-elem` refusal of `inline` in the
shell must be reported. Under `production` the script must run, with only the
report-only refusal. Its reports are caught by the spec and never reach the
run's log, so a refusal made on purpose can neither hide nor stand in for one
the functional specs caused. When the candidate was sabotaged (its
`script-src` dropped), the probe failed.

### A style nonce per shell response (proposed, 2026-10-29)

CodeMirror already has the hook: `EditorView.cspNonce` (view 6.43.9) is
passed to `style-mod` 4.1.3, which sets it on the `<style>` element it writes.
`liveEditorWeb/styleNonce.ts` reads the nonce the page was served with from
the IDL `nonce` property of the shell's own `<style id="context-ground">`
(browsers hide the attribute after load, the property stays readable by
script), and `mount.ts` hands it to the editor. A page served without one,
which is every page today, gets the empty string and CodeMirror sets nothing,
so this changes nothing in production on its own.

The fixture server proves the serving half with `E2E_CSP_NONCE=1`
(`csp-style-nonce.mjs`): every shell document gets 128 fresh random bits,
written as `nonce="…"` on its two inline styles and as `'nonce-…'` in every
`style-src` of that response's policies, enforced and report-only alike.
Nothing else in the document gets it, so a `srcdoc` preview's own style is
still refused. A `style-src` that allows `'unsafe-inline'` is refused rather
than nonced, because a browser drops `'unsafe-inline'` once a nonce is
present and that would quietly block every other inline style. The response
is `no-cache` with no `ETag` or `Last-Modified`: a validator would let a
revalidation pair a cached body's old nonce with a new header's, and the
shell would lose its own styles.

What it showed in Chromium over HTTPS, the whole policy enforced, editor
specs plus the negative probe: without the nonce 34 passed, 3 failed (both
scroll cases and the known new-tab link case) and the log held 14 enforced
`style-src-elem` refusals in the shell, each with its report-only
duplicate; with it 36 passed, 1 failed (the known new-tab link case, which
fails in Chromium without any policy too) and the log was empty.
`cspStyleNonce.spec.ts` checks the three places agree, the nonce is new on
every response, the editor's base theme applies, and a style without the
nonce is still blocked and reported (that report is caught in the spec and
kept out of the log). Serving one nonce in the header and another in the
body fails it, and so does a fixed nonce. The WebKit job runs the same under
`E2E_CSP_CANDIDATE=full E2E_CSP_NONCE=1`, before its script-only run.

**Recommendation.** The router mints the nonce, because it is the only part
that sees every shell response: for an HTML document answered from the
`ASSETS` binding, `crypto.getRandomValues` 16 bytes, add `nonce` to the two
shell styles with `HTMLRewriter`, add `'nonce-…'` to `style-src` in the
enforced and report-only policies of that same response, drop `ETag` and
`Last-Modified`, strip `If-None-Match` and `If-Modified-Since` before asking
`ASSETS` (so it never answers 304 with an old body), and send `no-cache`.
Ship it report-only first: the report-only policy gains the nonce while the
enforced one does not change, and production reports must show the shell's
`style-src-elem` rows gone before `style-src` is enforced. That enforcement
is a separate change, with the html preview and diagram style findings above
still open.

The service worker (`public/sw.js`) stores the whole shell response, header
and body together, under one key, and answers a navigation from it when the
network fails. Replayed as stored, that shell would carry a nonce some earlier
response already used, so a nonce would no longer be one per response. The
router change therefore has to come with a worker change: when the worker
answers from its cache, it mints a new nonce and rewrites the stored policy
headers and the two style attributes with it, the same three places, before
returning the response, or it stores the shell with the nonce removed and
adds a fresh one on the way out. Both halves are now built, report-only (2026-10-29):
`infra/router/src/styleNonce.ts` mints the nonce for every shell document
answered from `ASSETS` (a document request by `Sec-Fetch-Dest` or `Accept`,
outside `/drawing-assets/`, the page box and the plugin sandbox), strips the
conditional request headers and the validators, sends `no-cache`, and adds
the nonce to the report-only `style-src` only. The enforced policy is
unchanged. A document without the two shell styles is served as before.
`public/sw.js` re-mints the nonce on every offline replay (`renonced`).
`styleNonce.test.ts` holds the router's placement to the fixture's, on the
real `public/index.html`, and `appShellWorker.test.ts` checks three replays
get three new nonces.

Still not covered: browsers without constructable stylesheets.
`liveEditorWeb/stylesheet.ts` falls back to a `<style>` element there that
does not take the nonce, so under an enforced `style-src` those browsers
would still lose the live editor's own styles. That is the older-browser
limitation below, unchanged here.

### What this does not prove

- **Paths the fixture does not reach.** Sign-in with Turnstile, the
  Cloudflare beacon, and the landing page's X and Meta pixels are not in the
  E2E export. Production reports remain the only evidence for those.
- **The drawing editor's `'unsafe-eval'`.** With `'unsafe-eval'` removed from
  the editor's policy, `drawingFonts.spec.ts` still passed and nothing was
  reported. The `new Function` in Excalidraw's woff2 glue is not reached by
  drawing a scene. A green run here therefore says nothing about whether the
  editor still needs `'unsafe-eval'`, and its policy keeps it.
- **Older browsers.** The live editor's own stylesheet uses an adopted sheet
  where the browser has one, and falls back to a `<style>` element where it
  does not (`liveEditorWeb/stylesheet.ts`). That fallback is still inline
  style. An enforced `style-src` without `'unsafe-inline'` would leave those
  browsers unstyled, which is a known limitation, not something these specs
  cover.
- **Plugins, per push, and beyond the fetched releases.** The plugin specs
  run under the candidate daily only, and only with the releases
  `fetch-bundles.mjs` fetched. They cover those plugins, not every plugin.

- **The daily full WebKit suite.** It runs over plain HTTP, and has been red
  on `main` since at least 2026-10-26 (runs 40340892430, 40513541303,
  40706798971). Whether the HTTP diagram limitation is part of why is not
  established here. Moving it, or fixing what else fails there, is separate
  work.

### What a simplification would cost

Dropping the log check leaves a script blocked in a way no spec notices. The
sabotaged appearance hash shows this. Running only the `full` mode would turn
the job red on the style blockers above and hide any script regression behind
them. Enforcing `style-src` or `default-src` because this job is green would
claim more than it runs: it guards `script-src` only.
