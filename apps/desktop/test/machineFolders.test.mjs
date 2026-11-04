/**
 * The folders Tex may work in on this Mac (`main/machineFolders.ts`), chosen in
 * the Mac's own picker and saved on the gateway with the console's token.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   - `choose` saving when the picker was cancelled            "cancel changes nothing"
 *   - `read` taking the first computer instead of this Mac's    "reads this Mac's own folders, not another computer's"
 */

import { createMachineFolders, appRouteUrl } from "../src/main/machineFolders.ts";

function world({ id = "mch_mac", pick = null, machines } = {}) {
  const posts = [];
  let saved = ["/Users/a/Code"];
  const deps = {
    consoleToken: async () => "console-token",
    endpoint: () => "https://mcp.example.test/mcp",
    machineId: async () => id,
    pick: async () => pick,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ url, body, auth: init.headers.authorization });
      if (url.endsWith("/machines/app/list")) {
        return Response.json({ ok: true, machines: machines ?? [{ id: "mch_other", folders: ["/srv/elsewhere"] }, { id: "mch_mac", folders: saved }] });
      }
      saved = body.patch.folders;
      return Response.json({ ok: true, machine: { id: body.machineId, folders: saved } });
    },
  };
  return { posts, folders: createMachineFolders(deps) };
}

export async function runMachineFoldersChecks(check) {
  check("the app routes are the endpoint's origin, https only", appRouteUrl("https://mcp.example.test/mcp", "set") === "https://mcp.example.test/machines/app/set" && appRouteUrl("http://evil.example/mcp", "set") === null);

  {
    const { folders, posts } = world();
    const read = await folders.read();
    check("reads this Mac's own folders, not another computer's", JSON.stringify(read) === JSON.stringify(["/Users/a/Code"]));
    check("...naming no workspace, with the console's token", posts[0].body.workspaceId === undefined && posts[0].auth === "Bearer console-token");
  }
  {
    const { folders, posts } = world({ pick: ["/Users/a/Code/context", "relative", "/Users/a/Code/context"] });
    const chosen = await folders.choose();
    const set = posts.find((p) => p.url.endsWith("/machines/app/set"));
    check("choosing saves the picked folders on this Mac's row, absolute and each once", set?.body.machineId === "mch_mac" && JSON.stringify(set.body.patch) === JSON.stringify({ folders: ["/Users/a/Code/context"] }));
    check("...and answers what the gateway kept", JSON.stringify(chosen) === JSON.stringify(["/Users/a/Code/context"]));
  }
  {
    const { folders, posts } = world({ pick: null });
    const after = await folders.choose();
    check("cancel changes nothing: no save, and the folders already kept come back", !posts.some((p) => p.url.endsWith("/set")) && JSON.stringify(after) === JSON.stringify(["/Users/a/Code"]));
  }
  {
    const { folders, posts } = world({ id: null, pick: ["/x"] });
    check("before this Mac registered there is nothing to read or choose", (await folders.read()) === null && (await folders.choose()) === null && posts.length === 0);
  }
}
