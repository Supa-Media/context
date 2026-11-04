import { liveToolListSection, toolLine } from "../../tools/liveList.js";
import { toolText, toolError } from "../../tools/results.js";
import { chatgptCoverage } from "./operations.js";

/** Adapt only Context-owned guidance. Workspace note bodies are never rewritten. */
export function explicitWords(text) {
  return text
    .replaceAll("write with action save_session", "save_context")
    .replaceAll("write with action remember", "remember")
    .replaceAll("`about.md` with write when", "`about.md` with create_note or update_note when")
    .replaceAll("(manage visibility, share_link, website publish), and before every send", "(set_visibility, create_link, publish_website), and before any outbound message")
    .replaceAll("when you write, so", "when you call update_note, so")
    .replaceAll("as you learn it", "when the user requests keeping it");
}

export function explicitOrientation(tools) {
  return {
    notice: "This ChatGPT interface exposes each operation by its own name. Call orient about: \"tools\" for this connection's exact tool list. Other Context clients may use the six-tool interface; its write/manage/send spellings are not callable here.",
    say: explicitWords,
    access(text) {
      return text.replace(/## Forms and links, on write_note[\s\S]*$/, "## Forms and links\nUse create_form to create a form, and create_note or update_note for Markdown form blocks. Use the separately exposed create_link tool to share an existing note or collect form responses. These operations retain the existing role, visibility and approval checks.");
    },
    website(text) {
      return text.replace(/^- \*\*Saving is not publishing\.\*\*.*$/m, "- **Saving is not publishing.** Save source files with create_note or update_note. Use get_website_status, then check_website, and pass its draft to publish_website. Use screenshot_website for the published page. read_website_history reads prior versions; restore their files as a draft, check, then publish. get_website_domain reads DNS status; connect_website_domain connects a domain the user owns.");
    },
    async manual(about) {
      const offered = await tools();
      if (about === "tools") {
        const exclusions = chatgptCoverage().filter(row => row.exclusion).map(row => `- ${row.capability}: ${row.exclusion}`).join("\n");
        return toolText(`${liveToolListSection(offered)}\n\n## Explicit limitations\n${exclusions}\n- Dynamic connected-app reads are also excluded. list_connected_apps lists connections only.\n- save_context accepts a user-requested task summary, not raw conversation history.\n- Slack exposes only the fixed methods listed above.`);
      }
      const tool = offered.find(t => t.name === about);
      return tool ? toolText(`${toolLine(tool)}\n\n${tool.description}\n\nInput schema:\n${JSON.stringify(tool.inputSchema)}`) : null;
    },
    unknown(about) { return toolError(`No exposed operation named ${about}. Use orient about: "tools" for this endpoint's reviewed operations.`); },
  };
}
