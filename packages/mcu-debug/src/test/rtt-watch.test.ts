import test from "node:test";
import assert from "node:assert/strict";
import { RttWatchStore, parseWatchLine, WatchSource } from "../common/rtt-watch";
const source: WatchSource = { sessionId: "session-one", sessionName: "STM32", channel: 0, label: "[buzzer_debug]" };

test("RTT JSON parser accepts JSON Lines and named records; ignores ordinary text and malformed records", () => {
    assert.deepEqual(parseWatchLine(' buzzer_debug={"hz":4000}\r '), { watch: "buzzer_debug", value: { hz: 4000 } });
    assert.deepEqual(parseWatchLine('[1,true,null]'), { watch: "JSON", value: [1, true, null] });
    for (const line of ['hello', 'warning {"x":1}', 'x=garbage', '{bad}', '42', '"string"', 'x={"x":1} trailing']) assert.equal(parseWatchLine(line), undefined);
});
test("RTT chunk framing preserves UTF-8, waits for newline, handles CRLF and multiple records", () => {
    const store = new RttWatchStore(), bytes = Buffer.from('s={"text":"蜂鸣器","number":1}\r\ns={"text":"ready","number":2}\n');
    const split = bytes.indexOf(Buffer.from('蜂')) + 1;
    assert.equal(store.feed(source, bytes.subarray(0, split), 100).length, 0);
    const frames = store.feed(source, bytes.subarray(split), 101);
    assert.equal(frames.length, 2);
    assert.equal(Object.values(frames[0].values).includes("蜂鸣器"), true);
    assert.equal(Object.values(frames[1].values).includes(2), true);
    assert.equal(store.leaves.find(n => n.path[0] === "text")?.scalar, "ready");
});
test("RTT channels and sessions stay isolated even with identical labels and watch names", () => {
    const store = new RttWatchStore();
    const peers = [source, { ...source, channel: 1 }, { ...source, sessionId: "session-two" }];
    peers.forEach((s, i) => store.feed(s, Buffer.from(`v={"counter":${i}}\n`)));
    assert.equal(store.roots.length, 3);
    assert.equal(new Set(store.leaves.map(n => n.key)).size, 3);
    store.endSession(source.sessionId);
    assert.equal(store.isActive(store.roots[0].id), false);
    assert.equal(store.isActive(store.roots[2].id), true);
    assert.equal(store.feed(source, Buffer.from('v={"counter":99}\n')).length, 0);
    assert.equal(store.leaves.some(n => n.scalar === 99), false);
});
test("RTT snapshot schema replacement removes stale fields and handles nested arrays and type changes", () => {
    const store = new RttWatchStore();
    store.feed(source, Buffer.from('v={"a":{"b":1},"list":[true,null,"x"],"gone":3}\n'));
    const list = store.leaves.filter(n => n.path[0] === "list");
    assert.deepEqual(list.map(n => n.scalar), [true, null, "x"]);
    const update = store.feed(source, Buffer.from('v={"a":2,"list":[]}\n'))[0];
    assert.equal(update.structureChanged, true);
    assert.deepEqual(store.leaves.map(n => n.scalar), [2]);
    store.feed(source, Buffer.from('other={"z":9}\n'));
    assert.equal(store.leaves.length, 2);
    const next = store.feed(source, Buffer.from('v={"a":4,"list":[]}\n'))[0];
    assert.equal(next.structureChanged, false);
    assert.equal(store.leaves.find(n => n.watch === "v")?.changed, true);
});
test("RTT field identities handle arbitrary JSON keys and prototype names without collisions", () => {
    const store = new RttWatchStore();
    const frame = store.feed(source, Buffer.from('{"__proto__":{"x":1},"a/b":2,"a~b":3,"<img src=x>":"<script>"}\n'))[0];
    assert.equal(store.leaves.length, 4);
    assert.equal(Object.getPrototypeOf(frame.values), null);
    assert.equal(store.leaves.some(n => n.key?.endsWith('JSON/a~1b')), true);
    assert.equal(store.leaves.some(n => n.key?.endsWith('JSON/a~0b')), true);
    assert(store.leaves.every(n => /^[A-Za-z0-9_-]+$/.test(n.id)));
    assert.equal(({} as any).x, undefined);
});
test("RTT oversized/deep/nonfinite records are discarded atomically and next record still parses", () => {
    const store = new RttWatchStore();
    store.feed(source, Buffer.from('v={"good":1}\n'));
    assert.equal(store.feed(source, Buffer.from('v={"x":"' + 'x'.repeat(70000))).length, 0);
    assert.equal(store.feed(source, Buffer.from('"}\nv={"good":2}\n')).length, 1);
    assert.equal(store.feed(source, Buffer.from('v={"x":1e400}\n')).length, 0);
    const deep = '{"a":'.repeat(20) + '0' + '}'.repeat(20);
    assert.equal(store.feed(source, Buffer.from('v=' + deep + '\n')).length, 0);
    const many = JSON.stringify(Object.fromEntries(Array.from({length:4100}, (_, i) => ['x'+i, i])));
    assert.equal(store.feed(source, Buffer.from('v=' + many + '\n')).length, 0);
    assert.deepEqual(store.leaves.map(n => n.scalar), [2]);
    store.clear(); assert.equal(store.nodes.size, 0); assert.equal(store.roots.length, 0);
});
