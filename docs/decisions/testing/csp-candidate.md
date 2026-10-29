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
   the static shell, or mounting the editor in a shadow root. Both are design
   changes.
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
4. **The drawing editor's font fallbacks (`font-src`, esm.sh).** Excalidraw
   lists an esm.sh URL after ours for every face. Under report-only, the
   browser reports those URLs but fetches nothing. Enforced, each one becomes
   a request that fails with `csp` before it leaves the browser. The fonts
   still load from our origin. `drawingFonts.spec.ts` counts every off-origin
   request event, blocked ones included, so it fails. Nothing reaches esm.sh,
   but the guard cannot tell that, and it should not be loosened to tell it
   until `font-src` is the directive being moved.

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

So the job also runs over HTTPS (`E2E_HTTPS=1`). The Playwright config makes
a throwaway self-signed certificate for the run, the static server answers
over HTTPS on its own port, and only these browsers skip the certificate
check. First `mermaid.spec.ts` runs from the plain server, then the full
per-push spec list under `script`, with its own log check. The HTTP steps
stay in the job and stay red. They are the evidence for the scheme
difference, and no failure is ignored or excluded. Until the HTTPS run says
otherwise, no production policy or origin list changes.

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

### What a simplification would cost

Dropping the log check leaves a script blocked in a way no spec notices. The
sabotaged appearance hash shows this. Running only the `full` mode would turn
the job red on the style blockers above and hide any script regression behind
them. Enforcing `style-src` or `default-src` because this job is green would
claim more than it runs: it guards `script-src` only.
