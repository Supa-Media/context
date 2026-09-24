/**
 * The form tools: `create_form`, `submit_form`, `update_submission`, `retract_submission`, `vote_form`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function formToolDefinitions() {
  return [
    {
      name: "create_form",
      description:
        "Build a form on a new note: fields somebody fills in, answers appended to a second note " +
        "you name. Reach for it whenever they describe collecting the same thing from several " +
        "people — a client intake, a request list, a sign-up, a bug report — including from people " +
        "who cannot write notes at all. You pass fields and a policy, never markdown; the gateway " +
        "writes the block and creates the empty answers note in the same call, and tells you who " +
        "can read it. Who may read the answers is that note's own visibility, so say where it lands " +
        "before you make it. Convenience rather than the only way: write_note takes a form block " +
        "directly and its description carries the grammar, which is what to use if this tool is " +
        "not in your list.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The new note the form goes on, ending in .md. It must not exist yet." },
          title: { type: "string", description: "Heading for the note. Omit to write the block alone." },
          id: {
            type: "string",
            description:
              "A short lowercase name for the form, letters digits and dashes. Defaults to the note's own filename.",
          },
          intro: {
            type: "string",
            description:
              "A sentence or two above the form saying what it is for. Everyone who fills the form reads this.",
          },
          fields: {
            type: "array",
            minItems: 1,
            maxItems: 24,
            description: "What the form asks, in the order it asks it.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description:
                    "Lowercase letters, digits and underscores. It becomes the column heading, and cannot be id, by, at or votes.",
                },
                type: {
                  type: "string",
                  enum: ["line", "text", "select", "number", "date", "checkbox"],
                  description: "line is one line, text is a paragraph, select offers options.",
                },
                required: { type: "boolean", description: "Defaults to false." },
                max: {
                  type: "number",
                  description:
                    "Required on line (up to 500) and text (up to 20000), so an answer cannot be unbounded. An upper bound on a number field.",
                },
                min: { type: "number", description: "A lower bound on a number field." },
                options: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 24,
                  description: "The choices for a select field. No commas or square brackets in a choice.",
                },
              },
              required: ["name", "type"],
              additionalProperties: false,
            },
          },
          responses: {
            type: "string",
            description:
              "The note answers are written to. Defaults to the form's own path with -responses.md, and is never the form's own note.",
          },
          layout: {
            type: "string",
            enum: ["table", "sections"],
            description:
              "table is one row per answer and is the default; sections is one heading per answer, for long written replies. It cannot be changed once answers exist.",
          },
          submit: {
            type: "string",
            enum: ["member", "editor", "owner"],
            description:
              "The lowest role that may answer. member is the point of the feature: it lets people who cannot write notes file one. Defaults to member.",
          },
          edit_own: {
            type: "boolean",
            description:
              "Whether somebody may change or withdraw their own answer. Defaults to true, and only works where they can read the answers note.",
          },
          show_responses: {
            type: "boolean",
            description:
              "Whether the form widget lists existing answers. A display setting, never an access control — the answers note's visibility is that. Defaults to false.",
          },
          votes: {
            type: "string",
            enum: ["named", "off"],
            description: "named lets people upvote each other's answers, and names who voted. Defaults to off.",
          },
          notify: {
            type: "string",
            description:
              "Who gets an email every time somebody answers — owner, or a handle such as @dan. " +
              "Reach for it whenever they say they want to know when a form comes in. It is a " +
              "PERSON and never an address: Context mails a member of this context at the address " +
              "on their account, so an email address here is refused, and somebody who is not a " +
              "member of this context cannot be told however you spell them. The mail carries the " +
              "answers, so say that before you set it, and it only goes to somebody who could " +
              "already open the answers note. Leave it out and nobody is emailed.",
          },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description: "Enforced visibility for the form's own note.",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when a personal connection publishes the form's note to team.",
          },
          summary: {
            type: "string",
            description: "One short sentence for the activity line, as write_note takes.",
          },
        },
        required: ["path", "fields"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "submit_form",
      description:
        "Send an answer to a markdown form. The gateway checks the values against the form's fields, stamps your username and the time, and writes the row itself — you never send markdown, and you never need write access to the response file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note the form block is on" },
          form_id: {
            type: "string",
            description: "The form's id. Required only when the note carries more than one form.",
          },
          values: {
            type: "array",
            minItems: 0,
            maxItems: 24,
            description:
              "One entry per field you are answering. A field you leave out is left empty.",
            items: {
              type: "object",
              properties: {
                field: { type: "string", description: "The field's name, as the form declares it" },
                value: { type: "string", description: "Your answer, as text — numbers, dates and yes/no included" },
              },
              required: ["field", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "values"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "update_submission",
      description:
        "Replace the answers on a response you submitted. Allowed only where the form sets edit_own, and only on a response whose author is you.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note the form block is on" },
          form_id: {
            type: "string",
            description: "The form's id. Required only when the note carries more than one form.",
          },
          response_id: { type: "string", description: "The response's id, as shown in the response file" },
          values: {
            type: "array",
            minItems: 0,
            maxItems: 24,
            description:
              "The complete new set of answers. A field you leave out is cleared.",
            items: {
              type: "object",
              properties: {
                field: { type: "string", description: "The field's name, as the form declares it" },
                value: { type: "string", description: "Your answer, as text — numbers, dates and yes/no included" },
              },
              required: ["field", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "response_id", "values"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "retract_submission",
      description:
        "Delete a response you submitted. Allowed only where the form sets edit_own and the response is yours; an editor of the context may delete any response.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note the form block is on" },
          form_id: {
            type: "string",
            description: "The form's id. Required only when the note carries more than one form.",
          },
          response_id: { type: "string", description: "The response's id" },
        },
        required: ["path", "response_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "vote_form",
      description:
        "Add or remove your upvote on one response. Voters are listed by name so a vote can be taken back; a second vote from you is not a second count.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note the form block is on" },
          form_id: {
            type: "string",
            description: "The form's id. Required only when the note carries more than one form.",
          },
          response_id: { type: "string", description: "The response to vote on" },
          vote: {
            type: "string",
            enum: ["up", "none"],
            description: "up adds your vote, none takes it back. Defaults to up.",
          },
        },
        required: ["path", "response_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
