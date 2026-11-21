import test from "node:test";
import assert from "node:assert/strict";
import { LAYOUTS, authStorage, convexUrlOf, parseShots } from "./screenshots.mjs";

test("shots are paths with steps, named in order", () => {
  const shots = parseShots("/; /files/a.md | click:frame-aside-toggle | wait:800 | key:Control+L | type:hello");
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0], { path: "/", steps: [], name: "01-home" });
  assert.equal(shots[1].path, "/files/a.md");
  assert.deepEqual(shots[1].steps, [
    { kind: "click", value: "frame-aside-toggle" },
    { kind: "wait", ms: 800 },
    { kind: "key", value: "Control+L" },
    { kind: "type", value: "hello" },
  ]);
  assert.match(shots[1].name, /^02-files-a-md-frame-aside-toggle/);
});

test("nothing but a same-origin path is visited", () => {
  // A persona is signed in to the preview only; a URL or protocol-relative path would carry that browser elsewhere.
  for (const bad of ["https://evil.example/", "//evil.example/x", "files", "/a b", "/a\\b"]) {
    assert.throws(() => parseShots(bad), /is not a path/, bad);
  }
});

test("steps are the four kinds, with bounded waits and plain testIDs", () => {
  assert.throws(() => parseShots("/|eval:alert(1)"), /is not a step/);
  assert.throws(() => parseShots("/|wait:60000"), /wait is 0 to/);
  assert.throws(() => parseShots('/|click:a"]'), /is not a testID/);
  assert.throws(() => parseShots(Array(21).fill("/").join(";")), /At most 20/);
});

test("an empty list is the home page, and every layout Dev2 uses is taken", () => {
  assert.deepEqual(parseShots("").map((shot) => shot.path), ["/"]);
  assert.deepEqual(LAYOUTS.map((layout) => layout.name), ["desktop", "medium", "phone"]);
});

test("the tokens land where @convex-dev/auth reads them on the web", () => {
  const url = convexUrlOf("happy-otter-123");
  assert.equal(url, "https://happy-otter-123.convex.cloud");
  assert.deepEqual(authStorage({ url, token: "jwt", refreshToken: "rt" }), {
    __convexAuthJWT_httpshappyotter123convexcloud: "jwt",
    __convexAuthRefreshToken_httpshappyotter123convexcloud: "rt",
  });
  assert.throws(() => convexUrlOf("evil.example/x"), /Not a preview deployment/);
});
