/**
 * `uninstall` leaves a project as `install` found it, using the real add-mcp.
 *
 * The first real run left `.codex/config.toml` holding `mcp_servers = { }` and
 * an empty `.agents/skills/` behind: the entry and the skills were removed, the
 * file and folders install had created were not. What install created and
 * uninstall emptied is removed; what was there before stays, with anything
 * else in it.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installInto, uninstallRecords } from "../src/installer.js";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const codex = [{ id: "codex", name: "Codex", method: "mcp" }];
const options = (cwd) => ({ scope: "local", endpoint: "https://mcp.example.test/mcp", workspace: null, cwd, home: cwd, log: () => {} });

// A project with nothing in it: everything install makes, uninstall removes.
const fresh = await mkdtemp(join(tmpdir(), "context-cleanup-"));
let records = await installInto(codex, options(fresh));
check("install wrote the MCP config and the skills", records[0].ok && existsSync(join(fresh, ".codex", "config.toml")) && existsSync(join(fresh, ".agents", "skills", "context")));
await uninstallRecords(records, { log: () => {} });
check("uninstall removes the config file install created", !existsSync(join(fresh, ".codex")));
check("...and the skills folders it created", !existsSync(join(fresh, ".agents")));

// A project that already had its own Codex server and its own skill.
const lived = await mkdtemp(join(tmpdir(), "context-cleanup-"));
await mkdir(join(lived, ".codex"), { recursive: true });
await writeFile(join(lived, ".codex", "config.toml"), '[mcp_servers.mine]\nurl = "https://mine.example.test/mcp"\n');
await mkdir(join(lived, ".agents", "skills", "mine"), { recursive: true });
records = await installInto(codex, options(lived));
await uninstallRecords(records, { log: () => {} });
const kept = await readFile(join(lived, ".codex", "config.toml"), "utf8").catch(() => "");
check("a config file that was already there is kept, with its own server", kept.includes("mine.example.test") && !kept.includes("mcp.example.test"));
check("...and so is a skills folder that held something else", existsSync(join(lived, ".agents", "skills", "mine")) && !existsSync(join(lived, ".agents", "skills", "context")));

// A file install created, that the person has since added their own server to.
const adopted = await mkdtemp(join(tmpdir(), "context-cleanup-"));
records = await installInto(codex, options(adopted));
const configPath = join(adopted, ".codex", "config.toml");
await writeFile(configPath, `${await readFile(configPath, "utf8")}\n[mcp_servers.theirs]\nurl = "https://theirs.example.test/mcp"\n`);
await uninstallRecords(records, { log: () => {} });
check(
  "a file install created is kept once somebody else's server is in it",
  (await readFile(configPath, "utf8").catch(() => "")).includes("theirs.example.test")
);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
