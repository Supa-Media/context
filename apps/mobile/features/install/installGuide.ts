/**
 * What `context.lc/download` says, as data: the three ways to put Context on a
 * computer so Tex can run jobs there, and the instructions a person can hand
 * to their own coding agent instead of typing the commands.
 *
 * Every command here is the runner's own (`apps/machine-runner/README.md`,
 * `install.sh`, `src/pair.rs`, `src/service.rs`), and every download is an
 * address the router already redirects (`infra/router/src/download.ts`).
 * `__tests__/installGuide.test.ts` holds both to those files, so the page
 * cannot drift from what the runner actually does.
 *
 * The person is on their laptop. On a server they type the commands over SSH
 * and click the approve link in their laptop's browser; nothing here asks for a
 * phone.
 */

export type InstallTab = "mac" | "linux" | "headless";

/** The installer, fetched from `main` so the page never names a version. */
export const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/Supa-Media/context/main/apps/machine-runner/install.sh | sh";
export const PAIR_COMMAND = "context-machine pair";
export const SERVICE_COMMAND = "context-machine service install";
/** systemd stops a user's services at logout unless lingering is on (`service.rs` says so). */
export const LINGER_COMMAND = "loginctl enable-linger $USER";
export const STATUS_COMMAND = "context-machine status";
/** Where `install.sh` puts the binary when `CONTEXT_MACHINE_DIR` is unset. */
export const RUNNER_BIN = "$HOME/.context-machine/bin";
/** One paste for the app's Connect screen: install, then pair by full path, since PATH may not have it yet. */
export const INSTALL_AND_PAIR_COMMAND = `${INSTALL_COMMAND} && ~/.context-machine/bin/${PAIR_COMMAND}`;

export interface InstallLink {
  label: string;
  href: string;
  primary?: boolean;
}

export interface InstallStep {
  title: string;
  body?: string;
  /** Shell lines, shown in one block and copied together. */
  commands?: readonly string[];
  /** Under the block, in small type. */
  note?: string;
  links?: readonly InstallLink[];
}

export interface InstallSection {
  tab: InstallTab;
  /** The tab's label at a pointer width, and on a phone. */
  label: string;
  shortLabel: string;
  intro?: string;
  steps: readonly InstallStep[];
  /** One line after the steps. */
  aside?: string;
  asideLinks?: readonly InstallLink[];
}

export const INSTALL_TITLE = "Install Context";
export const INSTALL_LEAD =
  "Put Context on your computer so Tex can run jobs there, with your own Claude Code and Codex. Their sign-ins never leave that computer.";

const APPROVE_BODY =
  "It prints a link and a code. Open the link in your browser, where you're signed in to Context, check the code matches, and click Approve. It waits up to 30 minutes.";

export const INSTALL_SECTIONS: readonly InstallSection[] = [
  {
    tab: "mac",
    label: "Mac",
    shortLabel: "Mac",
    steps: [
      {
        title: "Download the app",
        links: [
          { label: "Download for Mac", href: "/download/mac", primary: true },
          { label: "Intel Mac", href: "/download/mac/intel" },
        ],
        note: "Apple silicon by default. Signed and notarized by Apple.",
      },
      { title: "Open it and sign in", body: "Drag Context into Applications, open it, and sign in with your email." },
      {
        title: "Let Tex use this Mac",
        body: "In the app, open Settings › Tex and turn on Let Tex use this Mac. Pick the folders Tex may work in. It shows up on your Tex page at once, with no code.",
      },
    ],
    aside: "A Mac that nobody logs in to, like a Mac mini in a closet? Use the Headless server tab instead.",
  },
  {
    tab: "linux",
    label: "Linux",
    shortLabel: "Linux",
    steps: [
      {
        title: "Install the runner",
        body: "No sudo. It goes in your home folder.",
        commands: [INSTALL_COMMAND],
        note: `If it says ${RUNNER_BIN.replace("$HOME", "~")} isn't on your PATH, add the line it prints to your shell profile.`,
      },
      { title: "Approve it in Context", commands: [PAIR_COMMAND], body: APPROVE_BODY },
      { title: "Keep it running", commands: [SERVICE_COMMAND], body: "It starts again whenever you log in." },
    ],
    aside: "Want the notes app on this computer too?",
    asideLinks: [
      { label: "AppImage", href: "/download/linux" },
      { label: ".deb", href: "/download/linux/deb" },
      { label: "AppImage (arm64)", href: "/download/linux/arm64" },
      { label: ".deb (arm64)", href: "/download/linux/deb/arm64" },
    ],
  },
  {
    tab: "headless",
    label: "Headless server",
    shortLabel: "Headless",
    intro:
      "For a server, a VM, or a Mac you reach over SSH. Type these on it, and approve it from the browser on your laptop.",
    steps: [
      {
        title: "Install the runner",
        commands: [INSTALL_COMMAND],
        note: `If it says ${RUNNER_BIN.replace("$HOME", "~")} isn't on your PATH, add the line it prints to your shell profile.`,
      },
      { title: "Approve it in Context", commands: [PAIR_COMMAND], body: APPROVE_BODY },
      {
        title: "Run it in the background",
        commands: [SERVICE_COMMAND, LINGER_COMMAND],
        note: "The second line keeps it running after you log out (Linux only). On a Mac, the service runs while someone is logged in.",
      },
      {
        title: "Check it",
        commands: [STATUS_COMMAND],
        body: "Then install or sign in to Claude Code and Codex from Your machines on your Tex page.",
      },
    ],
  },
];

/**
 * What the "Let your agent do it" card copies: the same steps, written for a
 * coding agent running on the computer. The person approves the pairing
 * themselves; a session with a Context connection could approve its own code
 * (`manage pair_device`), and for a computer that takes jobs that is the one
 * thing it must not do. Tex hands the same words in a text
 * (`apps/mcp/src/machines/setupPrompt.js`), held equal by the test.
 */
export function agentInstructions(tab: InstallTab): string {
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

export const AGENT_CARD_TITLE = "Let your agent do it";
export const AGENT_CARD_LEAD =
  "Paste this into Claude Code or Codex on that computer. You still approve it yourself, in your browser or by texting the code to Tex.";
export const INSTALL_FOOT = "Windows isn't supported yet.";

export function sectionFor(tab: InstallTab): InstallSection {
  return INSTALL_SECTIONS.find((s) => s.tab === tab) ?? INSTALL_SECTIONS[0];
}
