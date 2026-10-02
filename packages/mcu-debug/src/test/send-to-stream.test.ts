import test from "node:test";
import assert from "node:assert/strict";
import { sendToStream } from "../common/send-to-stream";

test("upstream !!send mapping preserves payload spacing and explicit stream addressing", () => {
    const writes: string[] = [],
        messages: any[] = [];
    const sinks = [
        {
            prefix: "[RTT#0]",
            write: (text: string) => {
                writes.push(text);
                return true;
            },
        },
        { prefix: "[uart]", write: () => false },
    ];
    sendToStream("  [RTT#0]   hello  ", sinks, (message) => messages.push(message));
    assert.deepEqual(writes, ["  hello  "]);
    assert.equal(messages[0].target, "[RTT#0]");
    sendToStream("help", sinks, (message) => messages.push(message));
    assert.equal(messages.at(-1).error, "ambiguous");
    sendToStream("[unknown] help", sinks, (message) => messages.push(message));
    assert.equal(messages.at(-1).error, "unknown-stream");
    sendToStream("[uart] help", sinks, (message) => messages.push(message));
    assert.equal(messages.at(-1).error, "not-connected");
});

test("upstream !!send bare newline, [] escape, malformed prefix and absent stream behavior", () => {
    const writes: string[] = [],
        messages: any[] = [];
    const sink = [
        {
            prefix: "[RTT#0]",
            write: (text: string) => {
                writes.push(text);
                return true;
            },
        },
    ];
    sendToStream("", sink, (message) => messages.push(message));
    sendToStream("[] [payload]", sink, (message) => messages.push(message));
    assert.deepEqual(writes, ["", "[payload]"]);
    sendToStream("[broken", sink, (message) => messages.push(message));
    assert.equal(messages.at(-1).error, "bad-prefix");
    sendToStream("", [], (message) => messages.push(message));
    assert.equal(messages.at(-1).error, "no-streams");
});
