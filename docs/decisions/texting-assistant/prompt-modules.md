# Texting assistant — the prompt in modules

### Tex's rules are module notes, and the setup names which ones each kind of turn gets

Decided by the owner on 2026-11-06, after the review of what goes into Tex's
context: "modular prompts so that we know what we are changing", reusable
across agents, then "split into modules now".

**Shape.** The texting setup (`@context-lc ai/production/texting-assistant.md`)
names its modules in front matter:

    modules:
      texts: [about-tex, tools, answering, sound-like-a-person]
      group: [about-tex, tools, answering, sound-like-a-person]
      job: [about-tex, tools, answering]

Each name is one note, `ai/production/prompt/<name>.md`, in the same pinned
workspace. A turn gets its kind's modules in the order named, each note's body
(its front matter is for people), joined by a blank line. `texts` is required;
`group` and `job` fall back to it. With `modules`, the setup's body is its
description for people and is never sent. A setup without `modules` works
exactly as before.

**Why one note per module.** A change to a module is one change, in one
note's history, wherever that module is used, and the setup's front matter
says which turns see it. The question "what are we changing" is answered by
the module's diff, not by a diff of a 45,000-character note.

**Reading.** The modules are read with the setup into the same warm copy
(`warmCopy.js`), so a warm text reads nothing more, and the setup's version in
the log covers its modules: a changed module is a new version. A named module
that is missing or empty refuses the whole setup, as any other fault in it
does, and logs `tex_setup_module_missing`: half a prompt is never run.

**Not yet.** The advisor and the job check keep their words in code
(`advisor.js`, `jobCheck.js`); giving them modules from the same notes is the
next step. Kinds are `texts`, `group` and `job` only, and an unknown kind
refuses the setup, so a typo never silently gives a turn the default.

Tests: `apps/mcp/test/agentJobHaiku.test.mjs` (the prompt in modules).
