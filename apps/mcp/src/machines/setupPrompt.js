/**
 * The prompt Tex hands a person for the coding agent on their computer, to put
 * Context's runner there so Tex can run jobs on it
 * (`docs/decisions/texting-assistant/computer-setup.md`). The same words as
 * the "Let your agent do it" card on `context.lc/download`
 * (`apps/mobile/features/install/installGuide.ts` `agentInstructions`), which
 * `apps/mobile/__tests__/installGuide.test.ts` holds equal to this, so Tex and
 * the page cannot drift apart. The gateway takes no dependency on the app, so
 * the words live twice and the test is what keeps them one.
 *
 * The agent never approves the code itself: a session with a Context
 * connection could (`manage pair_device`), and for a computer that takes jobs
 * that is the one thing it must not do. The person approves it, in their
 * browser or by texting the code to Tex in their own texts.
 */

export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Supa-Media/context/main/apps/machine-runner/install.sh | sh";
export const PAIR_COMMAND = "context-machine pair";
export const SERVICE_COMMAND = "context-machine service install";
export const LINGER_COMMAND = "loginctl enable-linger $USER";
export const STATUS_COMMAND = "context-machine status";
export const RUNNER_BIN = "$HOME/.context-machine/bin";

/** The computers a prompt is written for. */
export const SETUP_SYSTEMS = Object.freeze(["mac", "linux", "headless"]);

/** The prompt for one kind of computer; an unknown kind reads as Linux, whose steps are the most complete. */
export function setupPrompt(system) {
  const tab = SETUP_SYSTEMS.includes(system) ? system : "linux";
  const lines = [
    "Install Context's runner on this computer so Tex can run jobs here.",
    "",
    `1. Run: ${INSTALL_COMMAND}`,
    `2. Run: export PATH="${RUNNER_BIN}:$PATH"`,
    `3. Start \`${PAIR_COMMAND}\` in the background. It prints a link and a code, then waits up to 30 minutes. Show me the link and the code exactly as printed, and wait. I approve it myself, in my browser or by texting the code to Tex; never approve it yourself.`,
    `4. When it prints "Paired", run: ${SERVICE_COMMAND}`,
  ];
  if (tab === "mac") {
    lines.push(`5. Run \`${STATUS_COMMAND}\` and tell me what it says.`);
  } else {
    lines.push(`5. On Linux, run: ${LINGER_COMMAND}`, `6. Run \`${STATUS_COMMAND}\` and tell me what it says.`);
  }
  lines.push("", "Don't use sudo, and don't change anything else on this computer.");
  return lines.join("\n");
}
