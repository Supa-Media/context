# One drawing of Tex, changed with every architecture change (2026-11-05)

The owner asked on 2026-11-05 for a diagram of `texEntryPoint` and the answer
maker with all its models, and "a standing rule that any change to the
architecture must change the diagram, that way I can always go to the diagram
and see what changed". The drawing is
[`docs/architecture/tex.md`](../../architecture/tex.md): Mermaid, so GitHub
draws it and its history shows each change, with a change log line per pull
request.

**The rule:** a pull request that adds, removes, renames or reorders a step of
`texEntryPoint`, adds or switches a model, judge or check, or changes a lane,
queue or sender of the texting Worker, redraws that part in the same pull
request. A fix inside a file that leaves the shape as drawn says so in the
pull request's description: `Tex diagram: unchanged because <reason>`.

**The guard:** `scripts/tex-diagram-check.mjs`, in Fast repository guards. It
fails when a step the code runs is not drawn, or drawn in another order; when
a file naming a model id (Claude, Cloudflare, Gemini) is not named on the page;
and when a pull request changes a file the page names without changing the
page or giving the reason line. Its self-test breaks each of those on purpose.

**What a simplification would cost:** a drawing kept by hand only, or in an
artifact outside the repository, drifts from the code within days, which is
what happened to the 2026-10-30 and 2026-11-01 maps. Pictures elsewhere (the
illustrated maps) are views of this page, never a second source.
