/**
 * Which agent ran this hook.
 *
 * Claude Code and Codex share one `hooks/hooks.json` (Codex reads the Claude
 * format and sets `CLAUDE_PLUGIN_ROOT` for compatibility), so the command line
 * cannot say which one it is. Codex also sets `PLUGIN_ROOT`, which Claude Code
 * does not. Gemini CLI has its own hooks file and passes `--client gemini-cli`.
 *
 * The answer only labels the capture (`hook:<client>`), so a wrong guess files
 * a session under the wrong agent's name and nothing worse.
 */
export function hookClient(argv = process.argv, env = process.env) {
  const index = argv.indexOf("--client");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  if (env.PLUGIN_ROOT) return "codex";
  return "claude-code";
}
