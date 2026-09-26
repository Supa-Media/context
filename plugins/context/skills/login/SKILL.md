---
name: login
description: Sign this computer in to Context so sessions are saved to the user's inbox when they end. Run only when the user asks to sign in or to turn on session saving.
disable-model-invocation: true
---

# Sign in to Context

The Context connection this plugin adds signs in on its own. Saving sessions
when they end is separate: the session-end hook runs on this computer and needs
its own sign-in, which this skill makes.

`${CLAUDE_PLUGIN_ROOT}` below is the plugin's folder. Claude Code fills it in;
if you see it unfilled (Codex and ChatGPT show skills as files), use the folder
two levels above this `SKILL.md`, the one that contains `cli/`.

Run this command in a shell. It opens the user's browser to approve the
sign-in and waits up to five minutes for them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/context.mjs" login
```

Tell the user to approve the sign-in in the browser tab that opens. On the
approval page they choose whether Context can also read their private notes.

When the command finishes it prints the workspaces the sign-in reaches. Then
check that saving is on:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/context.mjs" config get capture
```

If it prints `off`, ask the user whether they want sessions saved, and only if
they say yes run `node "${CLAUDE_PLUGIN_ROOT}/cli/context.mjs" config set capture on`.

If you cannot run shell commands here (for example in Claude on the web), tell
the user to run this in a terminal instead:

```bash
npx -y @supa-media/context login
```
