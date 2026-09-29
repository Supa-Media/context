# A routing suggestion is a dry-run, never permission

Decided 2026-09-29 for the first multi-workspace routing backend.

An agent may propose where information belongs after it has oriented in the
relevant contexts. The gateway checks that proposal. It does not inspect the
information or infer a destination itself.

The `suggest_destination` request contains one to six candidates. Each
candidate has a context name and an integer confidence score from 0 to 100.
The request may classify the information as `personal`, `shared`, or `unknown`.
It has no field for note text, a note path, a title, or a rationale.

## Confidence thresholds

A candidate must score at least 75 to be suggested. The two strongest
candidates must be at least 10 points apart. A lower top score returns
`routing.confidence_too_low`. A smaller gap returns
`routing.destination_ambiguous`.

These numbers are part of contract version 1. Changing them changes which
requests wait for a person, so it requires new tests and a contract version.

## Authorization is a separate result

Every candidate is re-clamped through `sessionForContext`. That applies the
grant scopes to the caller's live role in that context. The response reports
each candidate as `authorized`, `read_only`, or `unreachable`.

Ranking happens before authorization. If the strongest candidate is
unreachable or read-only, the gateway blocks with
`routing.destination_unreachable` or `routing.destination_read_only`. It never
falls back to a lower-scoring writable context. A fallback would turn an
authorization failure into a semantic choice and could file information in the
wrong workspace.

Two spellings that resolve to one workspace are rejected with
`routing.duplicate_candidate`. This stops `@supa` and `SUPA` from creating
artificial ambiguity.

## Confirmation is not authorization either

A unique writable destination may still need a person. When personal or
unclassified information would cross into a shared workspace, the result is
`confirmation_required` with `routing.confirmation_required`, regardless of
confidence. This dry-run has no argument that waives the confirmation.

The later write must use the ordinary addressed tool call. That call resolves
the live grant again and applies the destination's privacy rules. A routing
decision ID is not a capability and no write path trusts it.

## Changed destinations

The result includes a SHA-256 decision ID over contract version, source
workspace, normalized candidates, scores, authorization results, and the
information classification. Passing that ID as `expected_decision_id` on a
later dry-run detects a changed score, destination, reach, role, or source and
returns `routing.destination_changed`.

The ID detects a stale review. It does not lock membership or storage. The
actual write still reauthorizes at call time.

## Audit rules

Ambiguous, unreachable, read-only, and duplicate results write nothing.
There is no authorized destination for an audit record in those states.

A unique authorized result records one `route_suggestion` event in the
suggested destination's own bucket. The event contains:

- contract version and decision ID;
- outcome and candidate count;
- top confidence;
- whether the route crosses a workspace boundary;
- whether confirmation is required.

The event has no paths and no candidate names, source name, note content,
title, rationale, or classification. It is owner-visible because a shared
workspace's members should not learn about activity in the caller's other
workspaces. If the destination cannot record the event, the gateway returns
`routing.audit_unavailable` and issues no suggestion.

## Stable outcomes

| Status | Code | Meaning |
| --- | --- | --- |
| `suggested` | none | One confident destination is writable and needs no privacy confirmation. |
| `ambiguous` | `routing.confidence_too_low` | The strongest score is below 75. |
| `ambiguous` | `routing.destination_ambiguous` | The two strongest scores are fewer than 10 points apart. |
| `blocked` | `routing.destination_unreachable` | The strongest name is malformed, missing, or outside this connection's reach. These cases stay indistinguishable. |
| `blocked` | `routing.destination_read_only` | The context is reachable but the live grant and role do not permit writes there. |
| `blocked` | `routing.duplicate_candidate` | More than one candidate resolves to the same destination. |
| `confirmation_required` | `routing.confirmation_required` | Personal or unclassified information would enter a shared workspace. |
| `changed` | `routing.destination_changed` | A prior decision ID no longer describes this dry-run. |
| `blocked` | `routing.audit_unavailable` | The destination could not store its content-free audit record. |

Schema errors remain the gateway's ordinary argument errors. They are not
routing outcomes.

## What this does not build

This does not write or move a note. It does not read note content. It does not
replace `orient`, search across contexts, or choose a path inside a workspace.
It does not approve a confirmation screen. Claude's UI artifact and Seyi's
approval are still required before a product flow implements confirmation.

Removing the tool removes no customer data and requires no migration. Existing
audit objects remain valid records of dry-runs that happened.

## The tests that hold it

`apps/mcp/test/crossContext/routingSuggestion.test.mjs` uses adjacent buckets
with identically named notes. It proves that a high-confidence unauthorized
candidate does not fall back, close scores do not choose, personal information
cannot cross into a shared workspace without confirmation, changed decisions
invalidate earlier reviews, and audit entries contain none of the information
being routed. The existing cross-context suite still proves that addressed
writes reauthorize against the destination role and storage binding.
