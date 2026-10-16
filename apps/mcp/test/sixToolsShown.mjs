/**
 * What a model was shown, read off the six tools the texting assistant holds
 * (`src/agent/sixTools.js`): each tool's name, and each action its
 * description lists, as `tool.action` (`write.propose`, `send.browse`).
 */
export function shown(tools) {
  const names = new Set();
  for (const tool of tools ?? []) {
    names.add(tool.name);
    const listed = String(tool.description ?? "").split("Your actions:\n")[1];
    if (!listed) continue;
    for (const line of listed.split("\n")) {
      const action = /^- ([a-z_]+):/.exec(line);
      if (action) names.add(`${tool.name}.${action[1]}`);
    }
  }
  return names;
}
