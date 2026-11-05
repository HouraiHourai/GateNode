import assert from "node:assert/strict";
import test from "node:test";
import { listItems } from "../src/items.ts";

const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));

test("legacy call returns all items without sharing the array", () => {
  assert.deepEqual(listItems(items), items);
  assert.notEqual(listItems(items), items);
});

test("pagination is one based and preserves source data", () => {
  const frozen = Object.freeze([...items]);
  assert.deepEqual(listItems(frozen, 2, 2), items.slice(2, 4));
  assert.deepEqual(listItems(frozen, 3, 2), items.slice(4));
  assert.deepEqual(frozen, items);
});

test("empty data and pages past the end return empty arrays", () => {
  assert.deepEqual(listItems([]), []);
  assert.deepEqual(listItems(items, 9, 2), []);
});

test("omitted page defaults to one and omitted pageSize defaults to the input length", () => {
  assert.deepEqual(listItems(items, undefined, 2), items.slice(0, 2));
  assert.deepEqual(listItems(items, 1), items);
  assert.deepEqual(listItems(items, 2), []);
  assert.deepEqual(listItems([], 1), []);
});

test("invalid explicit pagination arguments throw RangeError", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => listItems(items, value, 2), RangeError);
    assert.throws(() => listItems(items, 1, value), RangeError);
  }
});
