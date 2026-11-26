import { useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { AsideStrip } from "../console/aside/AsideStrip";
import { MailPage } from "../console/mailPage/MailPage";
import { MailRouteProvider, type MailRoute } from "../console/mailPage/MailRouteContext";
import type { MailNoteRow } from "../console/mailPage/model";
import { useColors } from "../design/theme";
import { densityFor } from "../app/frame";

/**
 * `screen=mail-page`: the Mail page beside the right rail's Mail button, on notes shaped like a busy shared
 * workspace's: an area's mail with its bot, a bot's own mail, two bots in one area, agents on a plan, and lines long
 * enough to find out whether a row or a message overflows. Nothing here reaches a gateway.
 */
const AT = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const LONG = "Here is the November spend so far, line by line: Grok is the biggest at $210, then Cloudflare at $96, Convex at $88, Resend at $41 and the rest under $20 each, which leaves $88 of room under the $600 target with five days to go.";

const TEXTS: Record<string, string> = {
  "areas/operations/finance/mail/seyi.md": `# Mail with Finance\n\n\`\`\`mail\n- ${AT(9)} @seyi to everyone: How much are we spending this month?\n- ${AT(2)} finance (Grok) to everyone [used 2%]: ${LONG}\n\`\`\`\n`,
  "bots/grok-bot/mail/seyi.md": `# Mail with Grok Bot\n\n\`\`\`mail\n- ${AT(70)} @seyi to everyone: Please check your card: if your name or logo changed, send the new ones.\n- ${AT(62)} grok-bot (Grok) to everyone [used 1%]: Logo updated. Name is the same.\n\`\`\`\n`,
  "areas/operations/finance/mail/grok-bot.md": `# Mail with Finance\n\n\`\`\`mail\n- ${AT(2900)} grok-bot (Grok) to everyone: What was November's total cost so far? Scoring every area for the Monday scorecard.\n- ${AT(2898)} finance (Grok) to everyone [used 1%]: $512 as of today.\n\`\`\`\n`,
  "products/search/speed-plan.md": `# Search speed plan\n\nThe plan.\n\n\`\`\`mail\n- ${AT(330)} builder (Claude) joined\n- ${AT(320)} reviewer (Codex) joined\n- ${AT(318)} builder (Claude) to reviewer: Index rebuild is in PR #4240. Reviewer, can you check the cold path?\n- ${AT(300)} reviewer (Codex) to builder: Cold path ok. One nit left on the PR.\n\`\`\`\n`,
  "areas/growth/socials/mail/shyoh.md": `# Mail with Socials\n\n\`\`\`mail\n- ${AT(2000)} @shyoh to everyone: Draft posts for Friday?\n- ${AT(1990)} socials (Grok) to everyone [used 4%]: Draft posts for Friday are up in products/website/drafts/friday-launch-posts-with-a-very-long-name.md.\n\`\`\`\n`,
};

function rowOf(path: string): MailNoteRow {
  const lines = TEXTS[path]!.split("\n").filter((line) => line.startsWith("- "));
  const said = lines.filter((line) => !line.endsWith(" joined"));
  const last = said[said.length - 1]!;
  const match = /^- (\S+) ([^ ]+)(?: \([^)]*\))? to ([^ :[]+)(?: \[used (\d+)%\])?: (.*)$/.exec(last)!;
  return {
    path,
    count: said.length,
    joined: [...new Set(lines.map((line) => line.split(" ")[2]!))],
    last: { at: match[1]!, from: match[2]!, to: match[3]!, used: match[4] ? Number(match[4]) : null, text: match[5]!.slice(0, 279) },
  };
}

export function MailPageFixture() {
  const colors = useColors();
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const [open, setOpen] = useState(true);
  const route = useMemo<MailRoute>(
    () => ({ open, workspaceId: "ws-fixture", me: "@seyi", openMail: () => setOpen(true), closeMail: () => setOpen(false), toggle: () => setOpen((was) => !was) }),
    [open],
  );
  const fixture = useMemo(
    () => ({
      load: async () => ({ notes: Object.keys(TEXTS).map(rowOf), complete: true }),
      io: {
        read: async (path: string) => ({ text: TEXTS[path] ?? "# Empty\n", etag: "e", readOnly: false }),
        write: async (path: string, text: string) => {
          TEXTS[path] = text;
        },
      },
    }),
    [],
  );
  return (
    <MailRouteProvider value={route}>
      <View style={[styles.frame, { backgroundColor: colors.pageSurface }]}>
        <View style={styles.page}>{open ? <MailPage route={route} compact={compact} onOpen={() => {}} onClose={route.closeMail} fixture={fixture} /> : null}</View>
        {compact ? null : <AsideStrip tabs={["meetings", "tex"]} showing="meetings" recording={false} onUnfold={() => {}} />}
      </View>
    </MailRouteProvider>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, flexDirection: "row", minHeight: "100%" },
  page: { flex: 1, minWidth: 0 },
});
