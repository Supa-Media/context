// The door `openSessionStore` lays between the routing layer (and a binding refresh behind the response) and the
// request's `ctx.waitUntil`, which `http/requestStore.js` fills only after the store opens (`src/sessionStore.js`
// `deferDoor`). Work handed to it before the door is filled is held and handed across once it is; after that it
// goes straight through; and a non-function leaves the door empty again.
import { test } from "node:test";
import assert from "node:assert/strict";

import { deferDoor } from "../src/sessionStore.js";

test("work handed before the door is filled is passed on once it is set, in order, and only once", () => {
  const door = deferDoor();
  const delivered = [];
  const first = () => delivered.push("first");
  const second = () => delivered.push("second");
  const third = () => delivered.push("third");
  door.later(first);
  door.later(second);

  assert.deepEqual(delivered, [], "nothing runs while the door is empty");

  const received = [];
  door.defer = (work) => received.push(work);
  assert.deepEqual(received, [first, second], "held work is handed across in the order it was handed in");

  door.defer = (work) => received.push(work);
  assert.deepEqual(received, [first, second], "setting defer a second time does not re-deliver held work");

  door.later(third);
  assert.equal(received.at(-1), third, "work handed after the first fill goes to the latest defer function");
  assert.equal(received.length, 3);
});

test("after the door is filled, later goes straight to the defer function", () => {
  const door = deferDoor();
  const received = [];
  door.defer = (work) => received.push(work);

  const work = () => {};
  door.later(work);
  assert.deepEqual(received, [work]);

  const other = () => {};
  door.later(other);
  assert.deepEqual(received, [work, other]);
});

test("defer reads null before the door is filled, and the function after", () => {
  const door = deferDoor();
  assert.equal(door.defer, null);

  const fn = () => {};
  door.defer = fn;
  assert.equal(door.defer, fn);
});

test("setting a non-function leaves defer null and keeps holding work", () => {
  const door = deferDoor();
  const held = () => {};
  door.later(held);

  door.defer = 42;
  assert.equal(door.defer, null);
  door.defer = "not a function";
  assert.equal(door.defer, null);
  door.defer = undefined;
  assert.equal(door.defer, null);

  const received = [];
  door.later(() => {});
  door.defer = (work) => received.push(work);
  assert.equal(received.length, 2, "work held before and during the non-function sets is still delivered on fill");
});

test("the routing layer's pattern sees a function only once the door is filled", () => {
  const door = deferDoor();
  assert.equal(typeof door.defer === "function", false);

  door.defer = () => {};
  assert.equal(typeof door.defer === "function", true);
});
