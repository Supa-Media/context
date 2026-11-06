# Gateway protocol: an edit's row lookup carries the note's Markdown

**Decided 2026-11-04**, for Dev's "every MCP tool under 0.1 s at the server".
An edit to an existing note (`write` with `expected_etag`) asked the workspace
object twice in a row before its merge: the row lookup (`ws.rows.lookup`,
about 25 to 41 ms in production) and then the body (`get`, about 20 to 36 ms).

### The rule

The write view's one-path lookup (`apps/mcp/src/store/idLayout.js`
`oneWrite`) asks `withBody`. Where the object answers that path `found: true`
for this reader, it puts the stored Markdown and its metadata beside the row
(`apps/mcp/src/workspaceStore/lookupBody.js`), and the id layer serves the
view's first plain `get` of that note from it, shaped as the object's own
`get` answers (`apps/mcp/src/store/workspaceRouting.js` `storedFromLookup`).

A body rides on the lookup only when all of these hold:
- the lookup itself found the row for this reader (`canSee` by the reader's
  own rules), on a live row;
- the row names a workspace note's own key (`notes/<noteId>.md`): never a Tex
  note's `tex/` key, never a folder;
- the object holds the notes (home `object`), and so does the gateway's
  binding: a gateway that still reads the bucket first reads it;
- the lookup names one path, the body is at most 1 MiB, and it is UTF-8
  exactly as stored.

Anything else answers the lookup as before, and the gateway reads the body
with its own `get`. A ranged or conditional `get`, and any read after the
first in the same view, asks the store.

### What it must not become

- **A wider read.** The body is the bytes the same request's `get` would have
  read next, for the row it would have read them from. Carrying one on a row
  the reader may not see, or on a lookup outside a write, is a leak.
- **Trusted over the bucket where the bucket answers.** In home `dual` the
  bucket is the truth; the object's copy is not served.

Tests: `apps/mcp/test/editLookupBody.test.mjs`.
