# Link Graph and Unified Retrieval: agent-authored contextual links

Section 13 of the architecture, kept in its own file so each stays under the repository's 1,000-line limit. Section numbers are unchanged; every other section is in [README.md](./README.md).

## 13. Agent-authored contextual links

### 13.1 What deserves an authored link

The user's agent should link a specific claim to useful supporting context: a decision it implements, evidence it relies on, a dependency, an earlier argument it extends, an exception, a contradiction worth inspecting, or a document it explicitly supersedes.

Similarity is how a candidate may be found, not the explanation for persisting the link. A candidate easily found by BM25 can still deserve a link when the prose records a meaningful relationship; the requirement is added information or navigational value, not that lexical retrieval be incapable of finding the target.

Good:

```markdown
Graph ranking extends the [[policies/visibility|existing visibility rule]]:
private notes must not influence results returned to a team reader.
```

Weak:

```markdown
Related: [[notes/privacy]], [[notes/search]], [[notes/graphs]].
```

The first records why the target matters at the precise point of use. The second can merely duplicate cheap relatedness. A legitimate sources/reference section is not forbidden; it must serve a purpose rather than satisfy a link quota.

Context does not promise to verify the semantics of an arbitrary agent's prose. Deterministic checks validate supported syntax, safe addressing, observed targets, and access, not whether one policy truly supersedes another.

### 13.2 Where the encouragement lives

Add concise policy to existing connect-time instructions, `orient`, and the `write_note` description, with the detailed guidance carried only when candidates are returned. Do not rely solely on `orient`, since some clients do not reach every tool.

Suggested instruction substance:

> Preserve existing useful references. When a source materially explains a claim, link it where that relationship is stated. Post-write candidates are optional leads, not verified relationships. Read enough of a candidate to confirm the relationship; skip topic-only matches. Do not rewrite a note just to add links.

MCP exposes tool results to the calling client; the client/model chooses its next call. A result is not a server-side invocation of the user's LLM, and the server cannot guarantee that a third-party agent follows the advice. Measure adoption across real clients. [E4]

No optional `sources_used`, read-history session state, plan token, commit token, or special link-authoring tool is added to the initial write contract.

Suggestions belong to `write_note` alone (O3). `remember`, which adds or replaces one line through the same write path, never returns them: a remembered fact is a single line, and a candidate list on every fact would cost each agent tokens for no authored link.

### 13.3 End-to-end MCP mechanics

The following objects show the **`params` of `tools/call`**, not complete transport envelopes. Use the gateway's existing negotiated protocol framing and required metadata. Existing argument names are taken from the reviewed `toolDefinitions()`. Proposed result fields below are an additive logical contract, not fields claimed to exist already. [R10]

**1. The client discovers tools and the agent optionally orients.**

```json
{
  "name": "orient",
  "arguments": {}
}
```

The agent receives the existing workspace orientation plus concise linking guidance. This is not a mandatory prepare step.

**2. The agent researches and reads the note it intends to update.**

```json
{
  "name": "read_note",
  "arguments": { "path": "plans/search.md" }
}
```

The response supplies the current body and its ETag, represented here as `example-v1`. The agent may call `search_notes` and `read_note` normally. Context does not infer that a token grant identifies this particular conversation.

**3. The agent submits its ordinary write.**

```json
{
  "name": "write_note",
  "arguments": {
    "path": "plans/search.md",
    "content": "# Search\n\n## Privacy\n\nGraph ranking extends the existing visibility rule: private notes must not influence results returned to a team reader.\n",
    "expected_etag": "example-v1"
  }
}
```

For a new note, omit `expected_etag` under the existing create contract. For a non-default workspace, use the existing `context` argument consistently. No preparation mode is introduced.

**4. Context commits before suggestion work.**

The existing mutation path authorizes and validates the request, performs the canonical write, and gets the committed ETag, represented as `example-v2`. Existing share/form/access side effects keep their own outcomes and are not redefined here.

Only after confirmed commit does Context identify eligible changed prose and run bounded candidate retrieval. It returns success even if that optional work is unavailable:

```json
{
  "saved": { "path": "plans/search.md", "etag": "example-v2" },
  "linkSuggestions": {
    "status": "ready",
    "basedOnEtag": "example-v2",
    "candidates": [
      {
        "path": "policies/visibility.md",
        "etag": "example-policy-v4",
        "section": "Privacy",
        "signals": ["text_match"],
        "excerpt": "Private material must not influence the ranking shown to a team reader."
      }
    ]
  }
}
```

The existing success text/content blocks remain valid. An implementation may add a validated `structuredContent` representation where supported, with a concise text equivalent. It must not replace an existing response schema incompatibly or claim every client exposes the structured representation to its model.

The server's signal is `text_match`, not a fabricated `extends` judgment. The agent supplies that interpretation after reading the evidence.

**5. The agent decides whether any follow-up is worthwhile.**

It may stop. The note is already saved. Or it reads the candidate:

```json
{
  "name": "read_note",
  "arguments": { "path": "policies/visibility.md" }
}
```

An excerpt sufficient to confirm a simple reference may avoid a full read; an uncertain or consequential relationship needs more evidence. A candidate's version is a statement of what was observed, not a reservation of the target.

**6. Any accepted link is an ordinary second write.**

```json
{
  "name": "write_note",
  "arguments": {
    "path": "plans/search.md",
    "content": "# Search\n\n## Privacy\n\nGraph ranking extends the [[policies/visibility|existing visibility rule]]: private notes must not influence results returned to a team reader.\n",
    "expected_etag": "example-v2"
  }
}
```

If the source changed meanwhile, the second write conflicts. The agent must read and reconcile rather than overwrite. If the target changed or disappeared, normal resolution/diagnostics apply; no hidden transaction has locked either file.

**7. Derived maintenance follows both committed writes.**

The first save has value without the second. A second write that merely wraps existing words in a link does not trigger another suggestion cycle; its actual graph facts still update.

### 13.4 Changed-section detection

Retain the exact pre-write body from the existing authorized read when available, and the exact committed body. On storage with live editing, `write_note` sends the submitted text to the collaboration engine, which merges it with edits made since the caller's base; the committed body is the engine's merged text, not the submitted content, and the base is the revision the caller read. Diff against those two. If no reliable old body is available, treat the content as new/unknown for bounded analysis or skip optional suggestions. Do not pretend a diff was measured against a version that was never read.

Deterministic implementation:

```text
exact old/new source
    -> bounded source-range diff
    -> Markdown structural/block analysis
    -> heading intervals constructed from document order
    -> changed ranges mapped to supported sections
    -> narrowly recognized trivial/link-only changes excluded
    -> eligible changed prose selected under a total budget
```

A full generic tree-edit-distance algorithm is not required. A text diff mapped to structural ranges provides the intended deterministic behavior with less machinery. This refines “AST diff” without assigning change detection to the LLM.

Headings define intervals ending at the next heading of equal or shallower depth; paragraphs are not assumed to be children of a heading node. Duplicate headings, new/deleted headings, nested lists, tables, and text before the first heading need tests. Range offsets must declare their encoding: use the existing engine's JavaScript string offsets consistently and measure storage/response limits separately in UTF-8 bytes.

Do not skip every edit below a size threshold. A negation, number, or target change can be meaningful. Formatting-only and pure link-wrapper changes may skip **suggestions**, but reference extraction/invalidation still processes their effects. Frontmatter, code, generated machine regions, and unsupported syntax do not receive routine semantic-link suggestions. Their relevant structural or access changes still invalidate indexes.

A brand-new long note does not get an unbounded candidate search per section. Cap the total note-level work, prioritizing supported new prose; report a limited pass rather than calling every section checked.

### 13.5 Optional work and latency

“Post-write” means after canonical commit, not necessarily after the HTTP response. There is a short, bounded enrichment phase before that response. It must not start a census, rebuild an index, wait for a projection to converge, or call a model.

Proposed initial **experiment settings**, not approved service guarantees:

| Setting | Initial value to benchmark |
|---|---|
| Changed sections inspected per write | At most 2. |
| Final candidate notes returned | At most 3, deduplicated across sections. |
| Structural traversal depth | At most 2 edge hops. |
| Added post-commit suggestion time | Hard budget of 250 ms, additionally constrained by remaining request time. |
| Rendered suggestion payload | At most 4 KiB total, including excerpts and guidance. |

Independent operation/byte/memory budgets also apply, above all the Worker subrequest ceiling (section 16.3): suggestion reads share one invocation with the write itself. These small limits intentionally allow suggestions to be absent on a cold or distant bucket. Expand them only if measured utility justifies the cost.

Logical statuses are `ready`, `none`, `skipped`, `unavailable`, and `partial`. `none` means the attempted bounded search found no candidate worth returning; it does not prove the workspace contains no relevant note. `skipped` covers ineligible changes or exhausted budget. Do not expose hidden corpus counts in any status.

Use cancellation/deadlines that prevent new work from starting after timeout. A `Promise.race` alone does not stop underlying operations; every started request must already have spent its budget. The deadline includes structural analysis, not just I/O. Bound diff/parser input and complexity and check the shared budget during CPU work; an asynchronous timer cannot interrupt a synchronous parser that blocks the runtime.

Maintenance scheduled after the response uses supported lifecycle/scheduler mechanisms. A host with no durable deferral path must use its documented bounded maintenance fallback or explicit maintenance trigger; fire-and-forget promises are not a durability guarantee.

### 13.6 Handler pseudocode

These are conceptual internal functions, not additional MCP tools:

```javascript
async function writeNoteWithHints(request, runtime) {
  // Existing policy, authorization, validation, conflict checks, and write.
  // Errors/unknown outcomes here retain the existing mutation contract.
  const saved = await existingCanonicalWrite(request, runtime);

  // Register only confirmed changes through the existing maintenance seam.
  // A projection failure cannot undo the save; reconciliation is the backstop.
  registerCommittedChangeBestEffort(saved, runtime);

  let hints = { status: "skipped", candidates: [] };

  try {
    if (runtime.suggestionBudget.canStart()) {
      hints = await withinSuggestionBudget(runtime, async signal => {
        // The same total deadline includes diffing and structural analysis.
        const sections = detectEligibleChangedSections({
          before: saved.observedBeforeBody,
          after: saved.committedBody,
          path: saved.path,
          limits: runtime.suggestionLimits,
          budget: runtime.suggestionBudget,
          signal
        });
        if (!sections.length || !runtime.suggestionBudget.canStart()) {
          return { status: "skipped", candidates: [] };
        }

        const candidates = await retrieveCandidates({
          workspace: runtime.authorizedWorkspace,
          intent: "link_suggestions",
          seed: { path: saved.path, sections, body: saved.committedBody },
          sourceVersion: saved.etag,
          signal,
          budget: runtime.suggestionBudget,
          allowMaintenance: false,
          allowModelCalls: false
        });

        return shapeVerifiedCandidateEvidence(candidates, saved, runtime);
      });
    }
  } catch {
    hints = { status: "unavailable", candidates: [] };
  }

  // Keep current success fields and framing; add only bounded optional data.
  return ordinaryWriteSuccess(saved, {
    linkSuggestions: { ...hints, basedOnEtag: saved.etag }
  });
}
```

`registerCommittedChangeBestEffort` must not throw after commit or create a new broad credential path. `shapeVerifiedCandidateEvidence` performs deterministic access/version/shape checks; it is not a semantic verifier model.

### 13.7 Loop prevention and audience safety

Do not suggest the source itself, an already linked target without a specific need, or an unlimited chain of neighbors. Never suggest after a `remember` call (section 13.2). Suppress suggestions after purely link-only enrichment. A bounded runtime cache may suppress duplicate suggestions for the same source/content version, but no persistent acceptance/dismissal ledger is required.

A note's audience matters as well as the writer's access. An owner can read private evidence while writing a team-visible note; suggesting that private title or excerpt for insertion may encourage disclosure. Prefer candidates whose target audience is at least as broad as the source's audience, using the existing access-policy semantics. Where that inclusion cannot be proven, withhold the candidate as an insertion suggestion rather than broaden access. This does not remove the owner's ability to search their private notes normally.

Writing a link does not grant target access. Conversely, the link text and the surrounding prose become part of the source note, so a later target-access change cannot erase information already written into that source. Never promise retroactive secrecy for authored text. Arbitrary agent prose can still contain a disclosure; this feature is not a semantic DLP system.

### 13.8 XML is optional presentation, not protocol or storage

MCP calls and structured outputs remain JSON. Notes remain Markdown. XML-like tags may delimit trusted guidance and quoted candidate evidence within a text result, but are neither a required format nor a new workflow state.

```xml
<link_suggestions based_on_etag="example-v2">
  <guidance>Optional leads. Confirm the relationship before adding a link.</guidance>
  <candidate path="policies/visibility.md">
    <signal>text_match</signal>
    <quoted_evidence>Private material must not influence team ranking.</quoted_evidence>
  </candidate>
</link_suggestions>
```

Escape all candidate-controlled text and attributes. XML delimiters do not turn untrusted note content into instructions and do not create a security boundary. No `<link_query_planner>` or `<verifier>` step exists behind this envelope.
