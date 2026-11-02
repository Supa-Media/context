# Storage and credentials — the files bucket

## Pictures and files stay in each workspace's own bucket, and pictures are kept compressed

**Decided by the owner, 2026-11-01**, as part of the workspace-objects move
("pictures compressed only", "PDFs and audio to the files bucket kept as
they are"). Note text, its rows and its editing history move into one Durable
Object per workspace. What is not text does not: pictures, PDFs and sounds
stay in a bucket.

### Which bucket

The workspace's own bucket, the one it already has. Tenancy was already
one bucket per workspace (non-negotiable #2), so the files bucket needs no
second bucket per workspace and no copy: once a workspace's notes are read
from its object, everything left in its bucket under `files/` and
`.context/assets/` *is* its files bucket. Every `notesHome` setting (bucket,
dual, object) sends those keys to the bucket and only there; the object never
holds a picture. A workspace still on a bucket of its own gets its files moved
with the full export that comes before bring-your-own storage is turned off
(the export thread), not by this one.

### What is compressed, and how

Every way a picture enters from a Worker re-encodes it first
(`packages/shared/src/pictureCompression.cjs`): a PNG, JPEG, WebP or HEIC
becomes a lossy WebP, quality 80, no side longer than 2,560 pixels. No
lossless copy is kept. A GIF is kept as it came, because it may move. A PDF or
a sound is never re-encoded. The ways in today:

- a picture an agent or Tex attaches to `write_note` (base64 or a URL;
  `apps/mcp/src/notes/uploadedImages.js`),
- a picture sent through an upload link (`apps/mcp/src/notes/imageUploads.js`),
- a picture attached to an email sent to a personal workspace
  (`infra/email-worker/src/ingest.ts`),
- a picture pasted in the app, compressed on the device before it is sent,
  the way a workspace icon photo already is (the control plane runs no
  encoder).

The encoder is Cloudflare's Images binding (`IMAGES`), a platform API, so the
gateway takes no codec dependency. A deployment without it, a self-hoster who
left it out, stores pictures as they came and logs `no_encoder`: compression
saves space and guards nothing, so its absence never refuses a picture. What
the encoder answers is not trusted: it must sniff as WebP, and be smaller than
what came in (a HEIC excepted, since no browser draws one), or the original is
kept. Each store logs `picture.stored` with types, sizes and the reason, and
never a name, key or byte.

### Names

A picture is still named from the bytes that arrived, so the same picture sent
twice is one object and an upload link's sha256 still finds it; the extension
is the stored copy's (`upload-<hash>.webp`). A picture already in a bucket
keeps its name and its bytes: notes point at those names, and nothing here
rewrites a note.

**Simplifying it** by naming the stored copy from its own bytes breaks the
upload link (the agent asks by the hash of the file it has), and re-encoding
an existing picture under its old `.png` name makes `read_image` hand a model
a type that does not match the bytes. **The tests that fail:**
`apps/mcp/test/pictureCompression.test.mjs`,
`apps/mcp/test/pictureCompressionUnit.test.mjs`, and `stores the compressed
copy, named from the bytes that arrived, and links it` in
`infra/email-worker/src/ingest.test.ts`.
