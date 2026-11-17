# The bench grades a cross-chat ask's asking turn

Decided while fixing the grading harness, 2026-11-17. A full round trip was
not built. This is what it would take.

## What is true now

The bench world (`apps/mcp/bench/world.mjs`) runs one chat's gateway turn.
`ask_chat` is offered only when the request carries `crossCounts` and the
control plane lists the person's groups (`texterGroups`). The bench stub does
neither, and `world.text` drops `crossAsks` when a turn returns them. The
texting Worker (`apps/agent/src/crossChat.ts`) is what queues the other chat
and brings the answer back. The bench does not run that Worker. A cross-chat
case can grade the asking turn. It cannot grade the other chat's answer or
the turn that brings it back.

The Lab sandbox already carries an ask between two test chats
(`apps/mcp/src/labSandbox/crossRuns.js`). That is a different world.

## What a round trip in the bench would be

Inside `converse`, after a turn, without new inbox objects:

1. Send `crossCounts: { hour: 0, day: 0, open: [] }` on every bench turn, and
   teach the stub `texterGroups` the person's shared workspaces as groups
   (the keys `groupChat.mjs` already makes).
2. For each `crossAsks` the answer carries, open that group's grant — a
   second token and ledger, not only the test's `group:` — and POST `/agent`
   with `event: chat_ask`, as `takeCrossAsk` does.
3. Read `crossBack` from that turn. The ask-run's draft is not texted into
   the group (`chatAnswer`).
4. POST the asking chat again with `event: chat_answer`, and append that
   turn's text to the conversation the judge reads.

One hop, in memory. The risk that kept it out of this change: the bench world
is one chat. A second grant wired wrong, or an ask-run whose draft is texted
into the group, would grade the wrong words.

## What a simplification would cost

Grading the asking turn as the whole case would pass a Tex that asks and
never hears back. `apps/mcp/test/crossChat.test.mjs` and
`apps/agent/src/crossChat.test.ts` still prove the gateway and the Worker.
They do not prove the bench grades the trip.
