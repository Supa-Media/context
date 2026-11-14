/**
 * A background job's object name in the gateway: `job:<id>`, the name the texting Worker's `SENDER_INBOX` gives the
 * job (`apps/agent/src/jobs.ts`, `JOB_PREFIX`). The id is a random UUID, or the id a gateway passes when it is well
 * formed (`ID` in `jobs.ts`: 8 to 64 letters, digits, `_` or `-`). Kept apart so the chat object, the job's object and
 * the TexTexts route all read one rule, and nothing that is not a job's name reaches a job's object.
 */
export const JOB_NAME = /^job:[A-Za-z0-9_-]{8,64}$/;
