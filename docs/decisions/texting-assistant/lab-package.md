# The Lab is one package, `packages/lab`, and it depends on Tex, never the reverse (2026-11-20)

Dev2, 2026-11-20, asking which packages exist and whether the Lab, Tex and the sandbox were "just spaghetti code":
"I would like lab and text done the same way" (as the preview sandbox's move into `packages/sandbox`). Until then the
Lab was spread over four apps: the page in `apps/mobile/features/tex/lab`, the test chats in
`apps/mcp/src/labSandbox`, the `tex_dev` tool in `apps/mcp/src/texDev`, the drafts and runs in Convex's `texLab*`,
and its shared logic in `packages/shared`.

**What lives in `packages/lab` (`@context/lab`).** Everything that is the Lab's own: the edits a draft is changed
with (`texLabOps`), the run report reader, run statistics and noise band, the test set edits, the failure triage and
the repo's test conversations (`texSetsRepo.generated.json`), and, moved in later steps, the page, the gateway's
sandbox and `tex_dev` logic, and the control plane's Lab logic.

**The page is `packages/lab/app`** (moved from `apps/mobile/features/tex/lab`); `apps/mobile/app/(app)/lab.tsx` is
its route and imports `@context/lab/app/TexLab`. What the page takes from the Context app (the staff chrome and
gate, the fonts, the console grant, the MCP address, the Tex page's ledger reader and types) it takes through one
folder, `packages/lab/app/fromApp/`, each file a re-export of the app's own module, so the seam is one place to read
and one place to cut when those pieces move. The app's source guards (window listeners, palette, type scale, field
fonts, action controls, device namespaces, Apple platform) scan the package too.

**The Lab's tests are in `packages/lab/__tests__`** and run in the app's jest (`roots` in
`apps/mobile/jest.config.js`), with the app's transform, React and mocks, because the page runs inside the app; the
app's typecheck includes them, and `check-mobile-outside-reads.mjs` counts what they read as the app's reads, so a
change to a file they read still runs them.

**A past turn is read where its commit kept it.** Replay reads the prompt catalogue at the commit a turn ran on, from
GitHub; a commit from before the move has it at the old path, so `catalogAt` tries `packages/lab/app` and then
`apps/mobile/features/tex/lab` (`CATALOG_PATHS`). Any file the Lab reads at an old commit keeps the same fallback
when it moves.

**What stays where a tool looks.** Convex deploys only `apps/convex/functions`, Expo Router serves only
`apps/mobile/app`, and a Worker's entry is its app's: those keep thin files that call into the package. Moving code
in is a pure refactor: no behaviour changes in the same pull request.

**The direction is one way.** The Lab reads Tex's config, graph, prompts and training (`packages/shared` today,
`packages/tex` once that move lands); Tex never imports the Lab. A Lab file needed by live Tex is a sign it is Tex's.

**The gateway reaches the package by relative path**, as it reaches `packages/shared`, so the gateway's one runtime
dependency rule (only `@context/collaboration` and the lazy `js-tiktoken`) is unchanged: no package manager
dependency is added to `apps/mcp`.

**CI gates name it.** Every gate that runs a reader's suite on `packages/shared/**` also lists `packages/lab/**`
(`ci.yml`'s shared, mobile and e2e filters and mobile path lists, `mcp.yml`'s gateway scope, and
`ci-change-scope.mjs`), so a change to the package runs the tests that read it.

*A simplification that would undo this:* copying a Lab helper back into an app "to save an import" splits its one
definition again; the Lab, control plane and gateway must run the same `texLabOps`.
