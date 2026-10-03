/**
 * `read_image`, `write_note`, and the tools that set a note's or a folder's visibility and encryption.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function noteWriteToolDefinitions() {
  return [
    {
      name: "read_image",
      title: "Read image",
      description:
        "Fetch one image that a note references. Images live in an opaque store that is never listed or searched, so an image is reachable only through a note you can already read: pass that note's path and the image reference as it appears in it. Returns the image inline.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Path of a note you can read that references the image, e.g. '0-inbox/email/capture.md'",
          },
          image: {
            type: "string",
            description: "The image as the note names it, e.g. '.context/assets/images/<hash>.png'; legacy '.images/' references and bare filenames also work",
          },
        },
        required: ["note", "image"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "write_note",
      title: "Write note",
      description:
        "Create or update a markdown note — this is how what you learned in this session survives " +
        "it. Use it when a decision is made, a constraint is discovered, a preference is stated, " +
        "or a fact emerges that the user should never have to repeat to the next agent; prefer " +
        "improving the note that already covers the topic over adding a near-duplicate. " +
        "Folder rules are defaults; visibility is enforced by the private privacy.md manifest, never by frontmatter. New personal writes default private; new team writes default team; updates preserve existing visibility. A personal connection may explicitly publish one note as team even inside a private-default folder by passing visibility=team and confirm_team_publish=true. " +
        "\n\nTHIS TOOL ALSO MAKES FORMS AND PUBLISHES NOTES, so you never need a separate tool for either. " +
        "A form is a fenced ```form block in the content; writing the note validates it and creates the answers note in the same call, and a block that does not parse is refused with the line that is wrong. The block is:\n" +
        "```form\nid: intake\nresponses: 1-projects/intake-responses.md\nlayout: table\nsubmit: member\nedit_own: true\nvotes: off\nfields:\n  - { name: who, type: line, max: 120, required: true }\n  - { name: brief, type: text, max: 2000 }\n```\n" +
        "id is a short lowercase name; responses is a note of its OWN, never this one; layout is table or sections; submit is the lowest role that may answer (member, editor or owner — use member for anything a link should collect); votes is named or off. Field types are line, text, select, number, date and checkbox; line and text need max, select needs options: [A, B]. Who may READ the answers is the responses note's own visibility, so say where it lands before you make it. " +
        "Add notify: owner — or notify: @handle — to EMAIL somebody every answer, which is what to reach for when they say they want to know when one comes in. It names a PERSON, never an address: the mail goes to a member of this context at the address on their account, an email address there is refused, and the mail carries the answers, so only somebody who could already open the answers note is told. " +
        "Then pass share to hand out a link to it — see that argument. " +
        "\n\nTHIS TOOL ALSO UPLOADS IMAGES. Pass images: [{ name, data | url, alt? }] and embed each one in the content by its name, e.g. ![[chart.png]] or ![a chart](chart.png), or in a site's HTML and CSS as src=\"chart.png\" or url(chart.png). " +
        "data is the image's base64 (a data: URI works too); url is an https address the gateway fetches once. Either way the bytes are stored inside this workspace, the embed is rewritten to point at that copy, and the image follows the note's visibility. " +
        "PNG, JPEG, GIF, WebP and HEIC, up to 5 MB each and 10 per call; SVG is refused. An image the content does not embed is added at the end. " +
        "A remote image link written straight into a note stays outside the workspace: the app draws it through a proxy, but it is not exported and breaks when its host removes it, and shared links and websites never load it — attach it here instead." +
        "\n\nTHIS TOOL ALSO COMMENTS, the way people comment in a shared document. read_note lists a note's open comment threads; " +
        "pass comment: { action: \"add\", quote, text } to highlight words and say something about them, or { action: \"reply\" | \"resolve\" | \"reopen\", thread, text? } to answer one. " +
        "Resolve a thread once you have acted on it: resolving keeps the whole thread in the note's history. " +
        "{ action: \"delete\", thread } takes back the latest comment this connection wrote in that thread (the whole thread, when that is the comment that started it); nobody else's comments can be deleted here.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Destination path ending in .md" },
          content: { type: "string", description: "The whole note. Required unless comment is passed instead." },
          comment: {
            type: "object",
            description:
              "Comment on this note instead of rewriting it; pass this without content. " +
              "add highlights the quoted words and starts a thread; reply, resolve, reopen and delete act on a thread by the id read_note lists. " +
              "The gateway writes the anchor and the log line into the note itself, signed with this connection's name.",
            properties: {
              action: { type: "string", enum: ["add", "reply", "resolve", "reopen", "delete"] },
              quote: {
                type: "string",
                description: "add: the exact words to highlight, as they read in the note (without markup the reader does not see).",
              },
              occurrence: {
                type: "integer",
                minimum: 1,
                description: "add: which appearance of quote, counting from 1, when it appears more than once.",
              },
              thread: { type: "string", description: "reply, resolve, reopen, delete: the thread id, e.g. k7f2." },
              text: { type: "string", description: "add and reply: what you are saying, up to 5000 characters." },
            },
            required: ["action"],
            additionalProperties: false,
          },
          expected_etag: { type: "string", description: "Etag from read_note; omit only when creating a new note." },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description: "Optional enforced visibility; frontmatter alone does not control access",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when personal access deliberately publishes a new or private note to team",
          },
          summary: {
            type: "string",
            description:
              "One short sentence saying what this write changed and why, for the people who share " +
              "this context: it becomes the line they read in activity.md. Say what a colleague " +
              "would want to know (\"recorded the folder rename and the paths it broke\"), never " +
              "what the tool call already says (\"updated a note\"). Omit it for a change nobody " +
              "else needs to hear about.",
          },
          images: {
            type: "array",
            maxItems: 10,
            description:
              "Images to store in this workspace and embed in the note. Each name is the placeholder the content embeds (![[chart.png]]); it is replaced by the stored image.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "The file name the content embeds this image as, e.g. chart.png" },
                data: { type: "string", description: "The image bytes as base64, or a data: URI. Pass this or url." },
                url: { type: "string", description: "An https URL to fetch the image from once. Pass this or data." },
                alt: { type: "string", description: "Alt text, used when the image is appended rather than embedded by name" },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          share: {
            type: "string",
            enum: ["members", "anyone", "collect"],
            description:
              "Also publish this note, in the same call. members needs a live membership, so a link that leaks opens nothing. anyone opens with no account. collect is anyone AND takes answers to a form on this note from people with no account — that is how a published intake form gets filled in, and it is the only write in this product with no account behind it. Asking for a link publishes this note to the workspace too (a link only opens what the workspace can read), so it needs no confirm_team_publish; the answers note keeps its own visibility. Owner-only: a writer who is not the owner still gets their note, and is told the link was refused. Omit it to publish nothing.",
          },
          share_short: {
            type: "string",
            description:
              "With share, a memorable name under their handle: context.lc/@name/<short>, lowercase letters, digits and hyphens. When they ask for a form or a link to send people, pick one from the note's name (new-client, feedback) rather than asking, and tell them it is guessable by anyone who types it, which is the point of having one and is not true of the long link. A name that is taken or reserved does not lose the link — you are told why it was refused.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      // Open world: `share` can publish this note to anyone on the internet,
      // and `images[].url` fetches from an outside host. Both directories
      // check this hint against what the tool can do.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "set_visibility",
      title: "Set note visibility",
      description:
        "Personal connection only. Set enforced visibility for one existing note without moving it. Private notes may coexist beside team notes in either folder default. Publishing private to team requires confirm_team_publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          visibility: { type: "string", enum: ["private", "team"] },
          expected_etag: { type: "string", description: "Optional current note etag" },
          confirm_team_publish: { type: "boolean" },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_encryption",
      title: "Set note encryption",
      description:
        "Personal connection only. Encrypt or decrypt one note's content in place. An encrypted note stays a file at its own path, readable through Context and stored as ciphertext in the bucket \u2014 so the storage provider and a leaked bucket key cannot read it. It is not end-to-end: this is encryption at rest, and people the note is already shared with can still read it through Context. Encrypted notes are not searchable.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          encrypted: { type: "boolean", description: "true to encrypt, false to decrypt" },
          expected_etag: { type: "string", description: "Optional current note etag" },
        },
        required: ["path", "encrypted"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "export_encryption_keys",
      title: "Export encryption keys",
      description:
        "Personal connection only, owner tier. Export this context's workspace data key(s) in the clear — every generation that opens an encrypted note in this bucket — in a versioned, language-neutral format documented in docs/decisions/encryption.md and readable by the offline decryptor in packages/encryption-decryptor. Exporting widens the blast radius: there is no un-export. Rate limited.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "rotate_encryption_keys",
      title: "Rotate encryption keys",
      description:
        "Personal connection only, owner tier. Rotate this context's workspace data key: mints a new key generation and re-wraps every encrypted note's key toward it, without re-encrypting any note body. Bounded per call — call again to resume an in-progress rotation. The retiring generation stays readable; nothing is deleted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_folder_visibility",
      title: "Set folder visibility",
      description:
        "Personal connection only. Dry-run or atomically set a folder's inherited visibility in privacy.md without a source checkout or rclone. Use visibility=inherit to remove that folder's direct rule. Applying requires the privacy etag returned by dry-run; any private-to-team publication also requires confirm_team_publish=true. Redundant exact-note overrides are compacted.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path without a trailing slash" },
          visibility: { type: "string", enum: ["private", "team", "inherit"] },
          dry_run: { type: "boolean", description: "Return the impact and current privacy etag without changing anything" },
          expected_privacy_etag: {
            type: "string",
            description: "Required when applying; use the privacy etag returned by dry-run",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required if the change makes existing or future notes under the folder team-visible",
          },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
