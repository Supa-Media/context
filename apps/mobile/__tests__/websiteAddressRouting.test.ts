import { describe, expect, test } from "@jest/globals";
import { siteRoutePathFrom } from "../features/site/host";

describe("a customer-domain website path", () => {
  test.each([
    ["/", "/"],
    ["/About", "/About"],
    ["/writing/hello", "/writing/hello"],
    ["/caf%C3%A9", "/café"],
    ["/writing/hello/", "/writing/hello"],
  ])("decodes %s once as %s", (raw, expected) => {
    expect(siteRoutePathFrom(raw)).toBe(expected);
  });

  test.each([
    "/intake%2Fextra",
    "/writing/%252e%252e/console",
    "/writing//hello",
    "/.hidden/page",
    "/bad%zz",
  ])("refuses the ambiguous or unsafe path %s", (raw) => {
    expect(siteRoutePathFrom(raw)).toBeNull();
  });
});
