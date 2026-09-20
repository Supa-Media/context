/**
 * The half of the local agent that touches the machine.
 *
 * `core/agent/localCli.ts` decides everything — which CLI, the argv, the tool
 * gate, what the output meant. This finds the binary, writes the config, runs
 * the process and deletes the file afterwards. The split is the usual one in
 * this app and it is what lets every decision above be checked offline, with
 * no `claude` installed on the machine running the suite.
 *
 * ## The grant is written, used, and removed
 *
 * `--mcp-config` needs the bearer token for this context, and the token lives
 * in the keychain in this process and has never been over the bridge. So it is
 * written to a file inside the app's own `userData`, created `0600`, handed to
 * the child as a path, and unlinked in a `finally` — including when the run
 * throws or times out, because a credential left on disk after a crash is the
 * same credential whether or not the crash was our fault.
 *
 * A fresh directory per run rather than one reused file: two questions asked at
 * once would otherwise share a path, and the first to finish would delete the
 * second's config out from under a running child.
 *
 * ## The scratch directory is the sandbox
 *
 * `localCli.ts`'s header carries the reasoning — without `--bare`, which would
 * cost us the subscription login, a `-p` run executes the hooks and MCP servers
 * it finds in its working directory with no trust prompt. So the run happens in
 * the empty directory made here, under `userData`, and never in the customer's
 * project, their home, or wherever Electron happened to start.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../platform/exec.ts";
import {
  LOCAL_MESSAGES,
  SCRATCH_PREFIX,
  abandonedRuns,
  type LocalAgentKind,
  askPlan,
  localAgentFor,
  mcpConfigFor,
  readLocalAnswer,
} from "../core/agent/localCli.ts";
import type { LocalAgentAsk, LocalAgentReply, LocalAgentStatus } from "@context/desktop-bridge";

/** How long one local turn may take. Generous: it is a whole agent loop. */
const TURN_TIMEOUT_MS = 180_000;

/** What the console calls it. The shell's word, not the page's guess. */
const DISPLAY_NAME = "Claude Code";

export interface LocalAgentDeps {
  /** Where to put the per-run directory. The app's `userData` in the shell. */
  scratchRoot: string;
  /** Absolute path to `claude`, or null. Probed once at startup by the caller. */
  claudePath: () => string | null;
  /** This machine's MCP endpoint, or null when it is not connected. */
  endpoint: () => string | null;
  /** The grant. Never leaves this process except into a 0600 file. */
  token: () => Promise<string | null>;
}

export interface LocalAgentRunner {
  status(): LocalAgentStatus;
  ask(request: LocalAgentAsk): Promise<LocalAgentReply>;
}

/**
 * Where the person is, as a sentence for `--append-system-prompt`.
 *
 * Deliberately the same facts the gateway's `describePlace` states, in the same
 * order, because the two roads should answer a question about "this note" the
 * same way. References only — a path and a visibility, never the text.
 */
export function placeSentence(place: LocalAgentAsk["place"]): string {
  const lines = [
    "You are answering inside Context, the person's own notes.",
    "Answer from their notes: search and read before you answer, and cite the note path.",
    "You cannot edit their notes. To suggest a change use propose_note; they review and decide.",
  ];
  if (place.context !== null) lines.push(`They are in the @${place.context} context.`);
  if (place.note !== null) {
    const state = place.note.unsaved ? " with unsaved edits" : "";
    lines.push(
      `The note open in front of them is ${place.note.path} (${place.note.visibility})${state}.`,
    );
  }
  if (place.meetingLive) lines.push("A meeting is being recorded right now.");
  return lines.join("\n");
}

/**
 * Remove the scratch directories of runs that never came back.
 *
 * ## Why a `finally` was not enough
 *
 * The header above says the grant is unlinked *"including when the run throws
 * or times out, because a credential left on disk after a crash is the same
 * credential whether or not the crash was our fault"* — and a `finally` reaches
 * neither of the cases that sentence actually describes. It runs on a throw and
 * on a timeout. It does not run when the process is killed: a force-quit, a
 * crash in the main process, a machine losing power, at any point in the three
 * minutes a turn may take. What survives is `mcp.json` with a live bearer grant
 * in it, in a plain file rather than in the keychain the token normally lives
 * in — and that difference is the whole reason the keychain is used.
 *
 * Nothing looked for one. Before this, `context-agent-` appeared in exactly one
 * place in the tree: the `mkdtemp` that creates it.
 *
 * ## At startup, and unconditionally
 *
 * The app takes no single-instance lock, so a second instance launched while
 * the first is mid-turn will remove that run's config and cost it one generic
 * failure — an answer the person can ask for again, and `ask` already has the
 * sentence for it. Weighed against a credential that otherwise stays on disk
 * for ever, that is the cheaper side, and an age threshold would not fix it:
 * the crash people actually restart from is the one they restart from
 * immediately.
 *
 * Every failure is swallowed, individually. A sweep that throws on one
 * undeletable entry and abandons the rest would leave the grant it was called
 * for, and there is nothing useful to say to somebody about a directory they
 * cannot see.
 */
export async function sweepAbandonedRuns(scratchRoot: string): Promise<void> {
  if (!scratchRoot) return;
  let entries: string[];
  try {
    entries = await readdir(scratchRoot);
  } catch {
    // No `userData` yet is the ordinary first launch, not a failure.
    return;
  }
  for (const name of abandonedRuns(entries)) {
    await rm(join(scratchRoot, name), { recursive: true, force: true }).catch(() => {});
  }
}

export function createLocalAgent(deps: LocalAgentDeps): LocalAgentRunner {
  function kind(): LocalAgentKind | null {
    return localAgentFor({ claudePath: deps.claudePath() });
  }

  return {
    status(): LocalAgentStatus {
      const available = kind() !== null;
      return { available, name: available ? DISPLAY_NAME : null };
    },

    async ask(request: LocalAgentAsk): Promise<LocalAgentReply> {
      const which = kind();
      const claudePath = deps.claudePath();
      if (which === null || claudePath === null) {
        return { ok: false, message: LOCAL_MESSAGES.failed };
      }
      if (request.question.trim().length === 0) {
        return { ok: false, message: LOCAL_MESSAGES.empty };
      }

      const endpoint = deps.endpoint();
      const token = await deps.token();
      if (endpoint === null || token === null) {
        return {
          ok: false,
          message: "This Mac is not connected to your context yet. Connect it and ask again.",
        };
      }

      const dir = await mkdtemp(join(deps.scratchRoot || tmpdir(), SCRATCH_PREFIX));
      const configPath = join(dir, "mcp.json");
      try {
        await writeFile(configPath, JSON.stringify(mcpConfigFor(endpoint, token)), {
          // The grant, on disk, for the length of one question. Owner only —
          // the default would be readable by every account on the machine.
          mode: 0o600,
        });

        const plan = askPlan(which, claudePath, {
          question: request.question,
          configPath,
          scratchDir: dir,
          appendSystemPrompt: placeSentence(request.place),
        });

        let stdout: string;
        try {
          stdout = await run(plan.command, plan.args, {
            timeoutMs: TURN_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            cwd: plan.cwd,
          });
        } catch {
          /*
            `run` throws on a non-zero exit as well as on a timeout, and the two
            are not distinguishable from here. A non-zero exit still printed its
            JSON on stdout, which is where a not-logged-in CLI says so — but
            `run` does not hand it back, so this path answers the generic
            sentence and `readLocalAnswer`'s not-logged-in branch is reached
            through the `is_error: true` shape instead. Named because it is a
            real gap: a CLI that exits non-zero *and* says "run /login" is told
            the less useful of the two sentences.
          */
          return { ok: false, message: LOCAL_MESSAGES.failed };
        }

        /*
          `true` because `run` throws on a non-zero exit, so reaching this line
          means the process exited cleanly. `readLocalAnswer` still checks
          `is_error`, which is the shape a clean exit uses to report a failure
          inside the run — a CLI that was never signed in, most often.
        */
        const read = readLocalAnswer(true, stdout);
        return typeof read === "string"
          ? { ok: false, message: read }
          : { ok: true, answer: read.answer, provider: read.provider, steps: read.steps };
      } catch {
        return { ok: false, message: LOCAL_MESSAGES.failed };
      } finally {
        // Including on a throw and on a timeout: a credential left behind by a
        // crash is the same credential.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
