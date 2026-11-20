/**
 * A background job born in the gateway keeps its pass loop's waiting in this Worker's job workflow: the gateway's
 * `TexJob` starts it over `TexRoutines.jobRun` (`chatCalls.ts`), and each pass reaches the job where it was born
 * (`jobWorkflow.ts` over `jobPlace.ts`). Only a job's id crosses.
 *
 * Sabotage record (2026-11-14): dropping the id check on `params.job` failed "refuses a start that names no job".
 */
import { describe, expect, it } from "vitest";
import { jobRun } from "./chatCalls";

function fakeWorkflow() {
  const created: Array<{ id: string; params: unknown }> = [];
  const got: string[] = [];
  return {
    created,
    got,
    async create(options: { id: string; params: { job: string } }) {
      created.push(options);
      return { id: options.id } as never;
    },
    async get(id: string) {
      got.push(id);
      return { id } as never;
    },
  };
}

describe("jobRun", () => {
  it("starts the job's workflow with only its id", async () => {
    const workflow = fakeWorkflow();
    expect(await jobRun(workflow, { op: "create", id: "job-abc12345", params: { job: "abc12345", text: "not passed" } })).toEqual({ ok: true });
    expect(workflow.created).toEqual([{ id: "job-abc12345", params: { job: "abc12345" } }]);
  });

  it("finds a started one", async () => {
    const workflow = fakeWorkflow();
    await jobRun(workflow, { op: "get", id: "job-abc12345" });
    expect(workflow.got).toEqual(["job-abc12345"]);
  });

  it("refuses a start that names no job, an unknown op, a bad id, or no workflow bound", async () => {
    const workflow = fakeWorkflow();
    await expect(jobRun(workflow, { op: "create", id: "job-x", params: { job: "a/b" } })).rejects.toThrow(TypeError);
    await expect(jobRun(workflow, { op: "create", id: "job-x", params: {} })).rejects.toThrow(TypeError);
    await expect(jobRun(workflow, { op: "delete", id: "job-x", params: { job: "abc" } })).rejects.toThrow(TypeError);
    await expect(jobRun(workflow, { op: "get", id: "" })).rejects.toThrow(TypeError);
    await expect(jobRun(workflow, null)).rejects.toThrow(TypeError);
    await expect(jobRun(undefined, { op: "get", id: "job-x" })).rejects.toThrow("no job workflow here");
    expect(workflow.created).toEqual([]);
  });
});
