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
        "Then pass share to hand out a link to it — see that argument.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Destination path ending in .md" },
          content: { type: "string" },
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
          share: {
            type: "string",
            enum: ["members", "anyone", "collect"],
            description:
              "Also publish this note, in the same call. members needs a live membership, so a link that leaks opens nothing. anyone opens with no account. collect is anyone AND takes answers to a form on this note from people with no account — that is how a published intake form gets filled in, and it is the only write in this product with no account behind it. Owner-only: a writer who is not the owner still gets their note, and is told the link was refused. Omit it to publish nothing.",
          },
          share_short: {
            type: "string",
            description:
              "With share, a memorable name under their handle: context.lc/@name/<short>, lowercase letters, digits and hyphens. Say first that a short name is guessable by anyone who types it, which is the point of having one and is not true of the long link. A name that is taken or reserved does not lose the link — you are told why it was refused.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_visibility",
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
      description:
        "Personal connection only, owner tier. Export this context's workspace data key(s) in the clear — every generation that opens an encrypted note in this bucket — in a versioned, language-neutral format documented in docs/decisions/encryption.md and readable by the offline decryptor in packages/encryption-decryptor. Exporting widens the blast radius: there is no un-export. Rate limited.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "rotate_encryption_keys",
      description:
        "Personal connection only, owner tier. Rotate this context's workspace data key: mints a new key generation and re-wraps every encrypted note's key toward it, without re-encrypting any note body. Bounded per call — call again to resume an in-progress rotation. The retiring generation stays readable; nothing is deleted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_folder_visibility",
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
