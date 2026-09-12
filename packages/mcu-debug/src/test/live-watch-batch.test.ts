import test from "node:test";
import assert from "node:assert/strict";
import { parseBatchExpressions } from "../frontend/views/live-watch-batch";

test("parses one Live Watch expression per line", () => {
    assert.deepEqual(parseBatchExpressions("foo\nbar.member\narray[index]"), ["foo", "bar.member", "array[index]"]);
});

test("trims, removes blank lines, and preserves first-seen order", () => {
    assert.deepEqual(parseBatchExpressions(" foo \r\n\r\nbar\nfoo\n bar "), ["foo", "bar"]);
});

test("does not split valid expressions containing commas or semicolons", () => {
    assert.deepEqual(parseBatchExpressions("fn(a, b)\ncondition ? left : right\nvalue; format"), ["fn(a, b)", "condition ? left : right", "value; format"]);
});
