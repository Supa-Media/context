# Gateway protocol: every change ends with its outcome, as data

**Decided by the owner, 2026-10-28** ("Every mutation should report whether it
applied, the resulting visibility and revision, and a specific error code").
An agent told a change apart from a refusal by its wording, and one that
misread an answer retried a change that had landed, or stopped at one that
had not.

### The rule

An MCP client's answer to any tool that writes ends with a second text block:

    outcome: {"applied":true,"path":"projects/plan.md","visibility":"team","etag":"c2.…"}
    outcome: {"applied":true,"unchanged":true,…}
    outcome: {"applied":false,"error":"CONFLICT"}

The error codes are `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`,
`CONFIRMATION_REQUIRED`, `NEEDS_PERSON` (the sharing judge, or an approval
the call waits for), `INVALID_ARGUMENT`, `UNAVAILABLE`, `UNKNOWN_TOOL` and
`FAILED`. It is built in one place, `apps/mcp/src/mcp/outcome.js`, from the
answer the tool already gave, at the MCP boundary (`mcp/handlers.js`), so no
tool can forget it and no tool's prose changes.

### Why a text block and not `structuredContent`

Some clients show only `structuredContent` when it is present, and the prose
has to reach the model whole: a conflict carries the text to merge into. A
second text block is read by every client.

### Why only MCP clients

Tex and the gateway's other agents call the same dispatcher and read the
first block. Every word they are handed costs the person tokens, and they
already parse the prose.

### What would break it

A refusal whose wording no longer opens the way `ERROR_CODES` expects falls
back to `FAILED`, which is honest but less useful; give a new refusal one of
the existing openings. `apps/mcp/test/outcome.test.mjs` fails if the block
goes missing from `tools/call`, or if a conflict stops being `CONFLICT`.
