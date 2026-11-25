import { describe, expect, it } from "vitest";
import { ASKED_RUN_PATHS, askControlPlane } from "./groupControl";
import type { GroupDeps } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import { JOB_REPORT_PATH } from "./jobTexts";
import { CROSS_ASK_PATH } from "./crossChat";
import { HANDBACK_PATH } from "./handbackWatch";
import { VAULT_SAVED_PATH } from "./vaultWatch";
import { JOINED_PATH } from "./groupJoined";
import { CHAT_LOOK_PATH } from "./groupRoutines";

/*
 * A group turn somebody asked for reads the asker's own reach (Dev2, 2026-11-25; `docs/decisions/texting-assistant/asker-reach.md`).
 * A text always is; of the runs that come in as routines, only the asker's own (their job's report, their ask from
 * another chat, the browser they handed back, the login they saved) say `asked`, and a check-in, the hello or a
 * routine never does, so the control plane gives those the chat's reach.
 *
 * Sabotage record (2026-11-25), each fails a test here:
 *  - `askControlPlane` sending `asked` for every routine: "a check-in, the hello and a routine are not asked";
 *  - `ASKED_RUN_PATHS` out of step with a path's own constant: "the asked paths are the runs' own".
 */

const LINE = "+15555550199";
const ADA = "+15555550101";

async function sent(message: Partial<GroupMessage>): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const deps = {
    controlPlaneOrigin: "https://control.example.invalid",
    workerSecret: "test-secret",
    fetch: async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "muted" }), { status: 200 });
    },
  } as unknown as GroupDeps;
  await askControlPlane(deps, { kind: "group-message", eventId: "e1", groupId: "g1", line: LINE, from: ADA, participants: [ADA, LINE], messageId: "m1", text: "hi", ...message } as GroupMessage, [ADA, LINE], null);
  return body;
}

describe("which group runs read the asker's own reach", () => {
  it("the asked paths are the runs' own", () => {
    expect([...ASKED_RUN_PATHS].sort()).toEqual([JOB_REPORT_PATH, CROSS_ASK_PATH, HANDBACK_PATH, VAULT_SAVED_PATH].sort());
  });

  it("a text is a plain turn: no routine, nothing more to say", async () => {
    const body = await sent({});
    expect(body.routine).toBeUndefined();
    expect(body.asked).toBeUndefined();
  });

  it("the asker's own runs say asked", async () => {
    for (const path of ASKED_RUN_PATHS) expect(await sent({ routine: { runId: "r1", path } })).toMatchObject({ routine: true, asked: true });
  });

  it("a check-in, the hello and a routine are not asked", async () => {
    for (const path of [CHAT_LOOK_PATH, JOINED_PATH, "areas/weekly.md"]) {
      const body = await sent({ routine: { runId: "r1", path } });
      expect(body.routine).toBe(true);
      expect(body.asked).toBeUndefined();
    }
  });
});
