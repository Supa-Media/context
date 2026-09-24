/**
 * The questions `install` asks, as arrow-key menus.
 *
 * Each has a default that is right for most people, so Enter works, and each
 * is skipped by the flag that answers it (`--scope`, `--workspace`, `--agent`);
 * `-y` skips them all and needs no terminal. Loaded only by `install` through a
 * dynamic import, so the session hooks never load `@clack/prompts`.
 *
 * Ctrl-C at any question throws `CANCELLED`, before anything has been changed:
 * install asks everything first and acts only after `confirmPlan`.
 */

import * as clack from "@clack/prompts";

export const CANCELLED = "cancelled; nothing was changed";

function answered(value) {
  if (clack.isCancel(value)) throw new Error(CANCELLED);
  return value;
}

export async function chooseScope() {
  clack.intro("Context");
  return answered(
    await clack.select({
      message: "Where should Context be installed?",
      initialValue: "user",
      options: [
        { value: "user", label: "Everywhere", hint: "every folder on this computer" },
        { value: "project", label: "This project, for the team", hint: ".context.json is committed" },
        { value: "local", label: "This project, just for me", hint: ".context.json stays out of git" },
      ],
    })
  );
}

/** `list` arrives with the suggested workspace first. */
export async function chooseWorkspace(list) {
  if (list.length <= 1) return list[0]?.slug || null;
  return answered(
    await clack.select({
      message: "Which workspace does this project belong to?",
      initialValue: list[0].slug,
      options: list.map((entry) => ({ value: entry.slug, label: `@${entry.slug}`, hint: `${entry.kind}, ${entry.role}` })),
    })
  );
}

export async function chooseAgents(detected) {
  if (!detected.length) return [];
  const ids = answered(
    await clack.multiselect({
      message: "Install into which coding agents? (space to toggle)",
      initialValues: detected.map((agent) => agent.id),
      required: false,
      options: detected.map((agent) => ({
        value: agent.id,
        label: agent.name,
        hint: agent.method === "mcp" ? "MCP server and skills" : "plugin: MCP server, skills, session hooks",
      })),
    })
  );
  return detected.filter((agent) => ids.includes(agent.id));
}

export async function chooseCapture(current) {
  const on = answered(
    await clack.confirm({
      message: "Save each coding session to your Context inbox when it ends?",
      initialValue: current !== "off",
    })
  );
  return on ? "on" : "off";
}

export async function confirmPlan({ scope, workspace, agents, capture }) {
  const where = { user: "every folder", project: "this project, for the team", local: "this project, just for me" }[scope];
  clack.note(
    [
      `Where:      ${where}`,
      ...(workspace ? [`Workspace:  @${workspace}`] : []),
      `Agents:     ${agents.join(", ")}`,
      `Capture:    ${capture === "on" ? "sessions saved to your inbox" : "off"}`,
    ].join("\n"),
    "Ready to install"
  );
  return answered(await clack.confirm({ message: "Install now?", initialValue: true }));
}
