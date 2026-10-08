/**
 * WHERE A BENCHMARK'S MODEL CALLS GO.
 *
 * The world (`world.mjs`) lets exactly one kind of request out: the gateway's
 * call to a Claude model, and the Workers AI binding for an `@cf/` model.
 * Here they are sent to the real thing with keys from the environment of
 * whoever runs the benchmark, never from a file:
 *
 *   AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_ID + AI_GATEWAY_TOKEN
 *                       Claude models through our Cloudflare AI Gateway, the
 *                       road texts take: ANTHROPIC_CREDIT_KEY (or
 *                       ANTHROPIC_API_KEY) first, Unified Billing after
 *   ANTHROPIC_API_KEY   without the gateway: Claude models straight to Anthropic
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN   `@cf/` models, through the Workers AI REST API
 *
 * `--fake` swaps both for a scripted model that searches once and repeats what
 * it found, so the plumbing (privacy, recorded changes, the result note) can be
 * checked with no key and no spend.
 */

const realFetch = globalThis.fetch;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const GATEWAY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Whether a failed call with the key should be tried again without it. */
async function retryWithoutKey(response) {
  if (response.status === 401 || response.status === 403 || response.status === 402) return true;
  if (response.status !== 400) return false;
  const text = await response.clone().text().catch(() => "");
  return /credit balance/i.test(text);
}

/**
 * How this run reaches Claude: `send(body)` posts one Messages API body and
 * returns the response. `send.route` says which road, or null with no keys.
 *
 * Through the gateway it mirrors the product (`src/agent/aiGateway.js`): the
 * plan's credit key first, and on a spent credit or a refused key the same
 * call again without it, which Unified Billing pays. Calls are tagged
 * `feature: benchmark` so the AI costs tab can tell them from people's texts,
 * and the gateway keeps no log of them.
 */
export function claudeTransport(env, fetchImpl = realFetch) {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID;
  const gatewayId = env.AI_GATEWAY_ID;
  const token = env.AI_GATEWAY_TOKEN;
  const key = env.ANTHROPIC_CREDIT_KEY || env.ANTHROPIC_API_KEY || null;
  const base = { "content-type": "application/json", "anthropic-version": "2023-06-01" };

  if (ACCOUNT_ID.test(accountId ?? "") && GATEWAY_ID.test(gatewayId ?? "") && token) {
    const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1/messages`;
    const headers = {
      ...base,
      "cf-aig-authorization": `Bearer ${token}`,
      "cf-aig-collect-log": "false",
      "cf-aig-metadata": JSON.stringify({ feature: "benchmark" }),
    };
    const post = (body, withKey) =>
      fetchImpl(url, { method: "POST", headers: withKey ? { ...headers, "x-api-key": key } : headers, body });
    const send = async (body) => {
      if (key) {
        const response = await post(body, true);
        if (!(await retryWithoutKey(response))) return response;
      }
      return post(body, false);
    };
    send.route = "gateway";
    return send;
  }

  if (env.ANTHROPIC_API_KEY) {
    const send = (body) =>
      fetchImpl(ANTHROPIC_URL, { method: "POST", headers: { ...base, "x-api-key": env.ANTHROPIC_API_KEY }, body });
    send.route = "anthropic";
    return send;
  }

  const send = async () =>
    json({ error: { message: "set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN, or ANTHROPIC_API_KEY" } }, 401);
  send.route = null;
  return send;
}

/** The world's gateway calls, sent the way `claudeTransport` chose. */
export function anthropicGateway(send) {
  return async (_url, init) => send(init.body);
}

/** A Workers AI binding over the REST API. */
export function workersAi(accountId, token) {
  return {
    async run(model, input) {
      if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are not set");
      const response = await realFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) throw new Error(`workers ai status ${response.status}`);
      return body.result;
    },
  };
}

/** The question's longest word, which is usually the thing to look up. */
function keyword(question) {
  return question.split(/[^A-Za-z]+/).sort((a, b) => b.length - a.length)[0] ?? "";
}

/**
 * A scripted Claude: on a fresh question it calls `search_notes` with the
 * question's longest word; once it has a tool result, it answers with the first line
 * of it. Enough to drive every part of the harness.
 */
export function fakeGateway() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    if (!result) {
      const question = typeof last?.content === "string" ? last.content : last?.content?.find((b) => b.type === "text")?.text ?? "";
      return json({
        content: [{ type: "tool_use", id: "toolu_fake", name: "search_notes", input: { query: keyword(question) } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1000, output_tokens: 20 },
      });
    }
    const text = typeof result.content === "string" ? result.content : (result.content ?? []).map((b) => b.text ?? "").join("\n");
    const line = text.split("\n").find((l) => l.trim()) ?? "Nothing found.";
    return json({ content: [{ type: "text", text: `Found: ${line.slice(0, 200)}` }], stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 30 } });
  };
}

/** The same script for an `@cf/` setup, in the Workers AI chat shape. */
export function fakeAi() {
  return {
    async run(_model, input) {
      const last = input.messages.at(-1);
      if (last?.role !== "tool") {
        const question = String(last?.content ?? "");
        const call = { id: "call_fake", type: "function", function: { name: "search_notes", arguments: JSON.stringify({ query: keyword(question) }) } };
        return { choices: [{ message: { content: "", tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 20 } };
      }
      const line = String(last.content ?? "").split("\n").find((l) => l.trim()) ?? "Nothing found.";
      return { choices: [{ message: { content: `Found: ${line.slice(0, 200)}`, tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 30 } };
    },
  };
}

const PERSON_SYSTEM =
  "You are playing a person texting their notes assistant, in a test. Reply as that person would text: short and plain. " +
  "Follow the brief exactly. Answer only what the assistant asked, using the brief's lines; never volunteer new requests. " +
  "If the assistant has finished and asks nothing, or the brief has nothing for what it asked, reply with exactly DONE.";

/**
 * The person's next text, or null when they have nothing more to say.
 *
 * @param {{ model: string, send: Function, fake?: boolean }} who  `send` from `claudeTransport`
 * @param {string} brief the question's section from the test file
 * @param {Array<{from: string, text: string}>} conversation so far
 */
export async function playPerson(who, brief, conversation) {
  if (who.fake) return null;
  const transcript = conversation.map((turn) => `${turn.from === "person" ? "You" : "Assistant"}: ${turn.text}`).join("\n\n");
  const response = await who.send(
    JSON.stringify({
      model: who.model,
      max_tokens: 300,
      system: PERSON_SYSTEM,
      messages: [{ role: "user", content: `Brief:\n${brief}\n\nConversation so far:\n${transcript}\n\nYour next text:` }],
    }),
  );
  if (!response.ok) throw new Error(`played person status ${response.status}`);
  const body = await response.json();
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return text === "" || text === "DONE" ? null : text;
}
