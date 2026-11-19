/**
 * The one request the chat page makes: a POST to the route with the console's
 * grant. Pure apart from `fetch`, and it never throws: a request that did not
 * reach the gateway is `null`, and the caller words that.
 */
import type { GrantRefresh } from "../../agent/consoleGrantCache";

/** What the route answered: its status, its JSON body (or a blob, when asked), and its content type. */
export interface ChatAnswer {
  status: number;
  body: unknown;
  contentType: string | null;
}

/** Sends one body to the route. `"blob"` reads the answer as bytes (a picture); the default reads JSON. */
export type ChatPoster = (body: unknown, as?: "json" | "blob") => Promise<ChatAnswer | null>;

/**
 * A poster for one route, with `mint` as the grant source. A refused token is
 * replaced once, never in a loop: the second answer is what the caller gets.
 * `mint`'s own failure (a refused mint, a timeout) is `null`, as a network
 * failure is. Its reason is dropped, because a thrown error can carry a URL.
 */
export function chatPoster(options: { route: string; mint: (refresh: GrantRefresh) => Promise<string> }): ChatPoster {
  const { route, mint } = options;
  return async (body, as = "json") => {
    const request = (accessToken: string) =>
      fetch(route, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const token = await mint(false);
      let response = await request(token);
      if (response.status === 401 || response.status === 403) {
        response = await request(await mint({ rejected: token }));
      }
      let parsed: unknown = null;
      try {
        parsed = as === "blob" ? await response.blob() : await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, contentType: response.headers.get("content-type") };
    } catch {
      return null;
    }
  };
}
