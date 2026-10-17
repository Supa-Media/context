/**
 * Setting a workspace up: `create_workspace`, `apply_layout`, `connect_google`
 * (decided by Dev2, 2026-10-17: what is UI-only about Context itself is doable
 * through the MCP). Reached as `manage` actions (`../v2/actions.js`); listed
 * here for their schemas, which is what those actions are checked against.
 */

export function workspaceToolDefinitions() {
  return [
    {
      name: "create_workspace",
      title: "Create a workspace",
      description:
        "Create a new shared workspace owned by the person, with them as its only member. slug is its " +
        "@handle (lowercase letters, digits and hyphens; permanent once claimed), name what it is called. " +
        "Pass dry_run: true first to check the handle is free without claiming it. A real create waits for " +
        "the person's yes, because a handle is never freed. Context gives it storage " +
        "it runs where it can; the answer says. Then lay it out with apply_layout, passing context set to " +
        "the new @handle. Inviting people is done in the app.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The @handle, e.g. acme-studio. Permanent once claimed." },
          name: { type: "string", description: "The name it is shown as, e.g. Acme Studio. Needed unless dry_run." },
          dry_run: { type: "boolean", description: "Only say whether slug is free; claim nothing." },
        },
        required: ["slug"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "apply_layout",
      title: "Lay out a workspace",
      description:
        "Lay down a workspace's starting folders, or add one built-in folder. template para is the five " +
        "standard folders (Inbox, Projects, Areas, Resources, Archive); business adds Clients and Teams; " +
        "product adds Teams and Products. A layout is written once, into a workspace whose storage is " +
        "connected and empty, by its owner. folder adds one built-in folder (clients, teams, products, or " +
        "a standard one it lacks) under its fixed name, for an owner or editor. Pass one of the two.",
      inputSchema: {
        type: "object",
        properties: {
          template: { type: "string", enum: ["para", "business", "product"], description: "The starting layout." },
          folder: {
            type: "string",
            enum: ["clients", "teams", "products", "inbox", "projects", "areas", "resources", "archive"],
            description: "One built-in folder to add.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "connect_google",
      title: "Link to connect Google",
      description:
        "Get the link where the person connects Gmail or Google Calendar to their personal workspace " +
        "themselves: they open it signed in to Context, press Connect, and sign in to Google. You cannot " +
        "finish a Google sign-in for them, and the link is the page, not Google's own address.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["gmail", "calendar"], description: "What to connect." },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
