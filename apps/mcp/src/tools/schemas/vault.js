/** The vault tools' definitions: logins an agent may name and ask about, never read. */

export function vaultToolDefinitions() {
  return [
    {
      name: "vault_list",
      title: "List saved logins",
      description:
        "The logins in this workspace's vault that this person may use: each one's id, name and the sites it fills on. " +
        "You never see a username or password, and nobody can give you one; Tex's browser fills them in itself. " +
        "A personal workspace's vault is the person's own; a shared workspace's holds logins people chose to share there.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "vault_add_link",
      title: "Link to save a login",
      description:
        "Get a private link where the person saves a login themselves, signed in to Context. " +
        "Use it whenever a login is needed and is not in vault_list, and whenever someone tries to send you a password: never take a password in a message. " +
        "Send them the link and say it is private to them and lasts 30 minutes.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "What to call it, e.g. Netflix. Optional; they can change it." },
          site: { type: "string", description: "The site it is for, e.g. netflix.com. Optional; they can change it." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "vault_share_link",
      title: "Link to share a login",
      description:
        "Get a link where the person confirms giving one saved login to another member of this shared workspace. " +
        "You cannot share a login yourself: only the person, signed in, can press Share on that page. " +
        "After they do, that member and their own assistants can have it filled in for them. " +
        "Personal logins stay personal: to share one, the person saves it in the shared workspace first (vault_add_link with context set to it).",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "The login's id, from vault_list." },
          with: { type: "string", description: "Who to share it with: their @handle." },
        },
        required: ["entry", "with"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
