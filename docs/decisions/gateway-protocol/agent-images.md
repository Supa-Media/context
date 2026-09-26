# Gateway protocol: an agent attaches an image

## An agent attaches an image through `write_note`, and the note embeds the workspace copy

Until this, an agent could read a picture back with `read_image` and could
never put one in. The image store had two writers, a paste in the app and an
email attachment, so an assistant asked to "add this screenshot to the note"
could only answer that it had no way to upload, and one that wrote
`![](https://…)` produced a note that showed nothing, because remote images
are never loaded (a remote image is a tracking pixel that reports every read
to whoever hosts it; see `apps/mobile/features/share/markdown.ts` and
[the pasted-image decision](../app-and-console/folder-rows-and-settings.md)).

`write_note` takes an optional `images: [{ name, data | url, alt? }]`. An
argument and not a tool, for the reason [a new argument reaches a client that
a new tool cannot](../gateway-protocol.md) gives. It is the paste, reached
from the other side:

- **The bytes go in the opaque store** under `upload-<16 hex of SHA-256>.<ext>`.
  Content-addressed, so the same image attached twice is one object and a
  retried write is idempotent. The leaf is checked against `read_image`'s own
  `imageRefFor`, so nothing is stored that could not be read back.
- **The note embeds the leaf.** Each embed whose target is exactly an image's
  `name` (`![[chart.png|480]]`, `![alt](chart.png)`) has only its target
  replaced, keeping the width, alias and link style. An image the content does
  not embed is appended on its own line, so nothing is stored unreferenced.
  The image has no visibility of its own and borrows the note's, exactly as a
  paste does, so `privacy.md` still decides everything.
- **A `url` is fetched once, by the gateway, and the note names the copy.**
  https only, default port, no userinfo, a name rather than an IP address, no
  `localhost`, at most three
  redirects each re-checked, 5 MB streamed with a hard stop. The remote host
  sees one fetch at write time and never a read.
- **The bytes decide the type**, never the caller's `data:` header or the
  remote `content-type`. PNG, JPEG, GIF, WebP and HEIC/HEIF by magic number.
  SVG has none and is a script container, so it is refused, as it is by the
  store and by `read_image`. 5 MB an image, 10 and 15 MB a write, because a
  Worker holds the base64 and the bytes at once.
- **Nothing is fetched or stored until every permission check has passed**,
  and the objects are written before the note — the paste's order, so a
  failure leaves an unreferenced object rather than a note pointing at
  nothing. A conflict after that point can leave such an object; a retry
  writes the same key.
- **An encrypted note, and a drawing, refuse images.** An encrypted note's
  text is sealed and an image's bytes would not be, which is the paste's rule.

**What a simplification of this costs.** Writing the remote URL into the note
instead of fetching it brings back the tracking pixel. Trusting the declared
type lets an HTML page or an SVG into the store under an image name. Storing
before the permission checks turns a refused write into a way to make the
gateway fetch arbitrary URLs and fill a bucket. A separate `upload_image` tool
would leave every client that cached its tool list without it.

The checks are `apps/mcp/test/uploadedImages.test.mjs`.
