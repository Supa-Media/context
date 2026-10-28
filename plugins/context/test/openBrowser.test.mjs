/**
 * Opening the sign-in page never goes through a shell, on any platform.
 *
 * The URL carries `&`-separated OAuth parameters. Through cmd.exe (Windows'
 * `start`) it was cut at the first `&` and the rest ran as commands, and a
 * security scan reports any spawn with `shell: true`.
 */

import { readFile } from "node:fs/promises";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const { browserCommand } = await import("../src/commands.js");
const HREF = "https://mcp.example.test/authorize?client_id=a&state=b&code_challenge=c";

for (const platform of ["darwin", "win32", "linux"]) {
  const [command, args] = browserCommand(platform, HREF);
  check(`${platform}: the whole URL is one argument`, args.at(-1) === HREF);
  check(`${platform}: no shell builtin`, command !== "start" && command !== "cmd" && command !== "cmd.exe");
}
check("win32: rundll32 opens it", browserCommand("win32", HREF)[0] === "rundll32");

const source = await readFile(new URL("../src/commands.js", import.meta.url), "utf8");
check("no spawn in commands.js asks for a shell", !/shell:\s*(true|process\.platform)/.test(source));

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
