/**
 * Approvals panel states for the right-panel tests. Fake addresses only.
 */
import type { ApprovalsView } from "../features/approvals/useApprovals";

/** A console that can answer approvals, with nothing waiting. */
export const NOTHING_WAITING: ApprovalsView = {
  available: true,
  phase: "listed",
  loading: false,
  items: [],
  error: null,
  busyId: null,
  notice: null,
  refresh: () => {},
  decide: () => {},
};

/** The same console with one email waiting for the person's yes. */
export const APPROVALS: ApprovalsView = {
  ...NOTHING_WAITING,
  items: [
    {
      id: "a1",
      summary: "send an email to sam@example.com",
      tool: "send_email",
      args: {},
      audience: null,
      client: "Claude",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60_000,
      kind: null,
    },
  ],
};
