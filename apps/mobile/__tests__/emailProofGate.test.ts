/**
 * "Check it's you" on the client: a refusal for want of an emailed code opens
 * the one dialog and runs the call again exactly once, and only once a code
 * was confirmed. Every other failure passes straight through.
 */
import { describe, expect, test } from "@jest/globals";
import {
  installEmailProofRetry,
  needsEmailProof,
  requestEmailProof,
  settleEmailProof,
  subscribeEmailProof,
} from "../features/account/emailProofGate";

const refusal = () => Object.assign(new Error("Check it's you"), { data: { code: "EMAIL_PROOF_REQUIRED" } });

function fakeClient(failures: unknown[]) {
  const calls: unknown[][] = [];
  const answer = async (...args: unknown[]) => {
    calls.push(args);
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return "done";
  };
  return { client: { mutation: answer, action: answer }, calls };
}

describe("email proof retry", () => {
  test("recognises only the proof refusal", () => {
    expect(needsEmailProof(refusal())).toBe(true);
    expect(needsEmailProof(new Error("other"))).toBe(false);
    expect(needsEmailProof({ data: "EMAIL_PROOF_REQUIRED" })).toBe(false);
    expect(needsEmailProof(null)).toBe(false);
  });

  test("with no dialog mounted, the refusal comes straight back", async () => {
    const { client, calls } = fakeClient([refusal()]);
    installEmailProofRetry(client);
    await expect(client.mutation("x")).rejects.toMatchObject({ data: { code: "EMAIL_PROOF_REQUIRED" } });
    expect(calls).toHaveLength(1);
  });

  test("a confirmed code runs the call again once", async () => {
    const opened: boolean[] = [];
    const stop = subscribeEmailProof((open) => {
      opened.push(open);
      if (open) setTimeout(() => settleEmailProof(true), 0);
    });
    const { client, calls } = fakeClient([refusal()]);
    installEmailProofRetry(client);
    await expect(client.action("y", { a: 1 })).resolves.toBe("done");
    expect(calls).toEqual([["y", { a: 1 }], ["y", { a: 1 }]]);
    expect(opened).toContain(true);
    stop();
  });

  test("closing the dialog lets the refusal through and does not retry", async () => {
    const stop = subscribeEmailProof((open) => {
      if (open) setTimeout(() => settleEmailProof(false), 0);
    });
    const { client, calls } = fakeClient([refusal()]);
    installEmailProofRetry(client);
    await expect(client.mutation("z")).rejects.toMatchObject({ data: { code: "EMAIL_PROOF_REQUIRED" } });
    expect(calls).toHaveLength(1);
    stop();
  });

  test("a second refusal after the code is not retried again", async () => {
    const stop = subscribeEmailProof((open) => {
      if (open) setTimeout(() => settleEmailProof(true), 0);
    });
    const { client, calls } = fakeClient([refusal(), refusal()]);
    installEmailProofRetry(client);
    await expect(client.mutation("z")).rejects.toMatchObject({ data: { code: "EMAIL_PROOF_REQUIRED" } });
    expect(calls).toHaveLength(2);
    stop();
  });

  test("other failures are not touched, and installing twice wraps once", async () => {
    const { client, calls } = fakeClient([new Error("boom")]);
    installEmailProofRetry(client);
    installEmailProofRetry(client);
    await expect(client.mutation("w")).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
  });

  test("two refusals at once share one dialog", async () => {
    let opens = 0;
    const stop = subscribeEmailProof((open) => {
      if (open) opens += 1;
    });
    const first = requestEmailProof();
    const second = requestEmailProof();
    expect(first).toBe(second);
    settleEmailProof(true);
    await expect(first).resolves.toBe(true);
    expect(opens).toBe(1);
    stop();
  });
});
