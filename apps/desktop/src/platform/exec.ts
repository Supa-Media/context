/**
 * Running a command and getting a string back, with a timeout that is not
 * optional.
 *
 * Every macOS collector is a shell-out, and two of them — AppleScript against
 * System Events and against Calendar — can block for a long time or forever
 * when the permission they need has never been granted or when the app they
 * talk to is beach-balling. A collector that never resolves stalls the poll
 * loop, and the poll loop is the only thing that would ever notice a meeting.
 * So the timeout lives here rather than in each caller's good intentions.
 *
 * A timed-out or failing command **throws**. `collectSignals` turns that into
 * "this collector is degraded", which is a different statement from "there are
 * no meetings" — see `core/detection/collectors.ts`.
 */

import { execFile } from "node:child_process";

export interface RunOptions {
  timeoutMs?: number;
  /** Cap on stdout. A runaway `ps` must not become a gigabyte of string. */
  maxBuffer?: number;
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs ?? 4_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        killSignal: "SIGKILL",
        // No shell, ever: every argument here is built from data that has been
        // near a window title, and a window title is attacker-controlled text
        // on any machine where somebody can name a document.
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          // The error's message can carry the whole command line, which for
          // osascript is a script containing app names. Replaced with the
          // command's own name.
          reject(new Error(`${command} failed`));
          return;
        }
        resolve(stdout);
      },
    );
    child.on("error", () => reject(new Error(`${command} failed`)));
  });
}

/** `osascript -l JavaScript -e <script>`, which is the one we use everywhere. */
export function osascript(script: string, options: RunOptions = {}): Promise<string> {
  return run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], options);
}
