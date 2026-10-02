import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RttWatchStore, WatchSource } from "../common/rtt-watch";
import { RttWatchRecording } from "../common/rtt-watch-capture";
import { LineBuffer } from "../common/utils";

const rtt: WatchSource = { sessionId: "session", sessionName: "MCU", channel: 0, label: "[data]" };
const uart: WatchSource = { sessionId: "session", sessionName: "MCU", transport: "UART", port: "/dev/ttyUSB0", label: "[data]" };

test("JSON Watch isolates RTT and multiple UART ports with the same labels and record names", () => {
    const store = new RttWatchStore();
    [rtt, uart, { ...uart, port: "/dev/ttyUSB1" }, { ...uart, sessionId: "other" }].forEach((source, n) => {
        store.feed(source, Buffer.from(`v={"n":${n}}\n`));
    });
    assert.equal(store.roots.length, 4);
    assert.equal(new Set(store.leaves.map(n => n.key)).size, 4);
    assert.deepEqual(store.leaves.map(n => n.scalar), [0, 1, 2, 3]);
    assert(store.roots.some(n => n.label.includes("UART /dev/ttyUSB0")));
    assert(store.leaves.some(n => n.key === "session/RTT0/v/n"), "Existing RTT keys stay stable");
});

test("UART disconnect drops partial JSON/UTF-8 and resumes without reviving an ended session", () => {
    const store = new RttWatchStore();
    store.feed(rtt, Buffer.from('v={"n":10}\n'));
    store.feed(uart, Buffer.from('v={"n":20}\n'));
    const root = store.roots.find(n => n.label.includes("UART"))!;
    store.feed(uart, Buffer.from('v={"n":999,"text":"'));
    store.endSource(uart);
    assert.equal(store.isActive(root.id), false);
    assert.equal(store.isActive(store.roots[0].id), true);
    const frame = store.feed(uart, Buffer.from('v={"n":21}\r\n'))[0];
    assert.equal(frame.structureChanged, true);
    assert.equal(store.isActive(root.id), true);
    assert.deepEqual(Object.values(frame.values), [21]);
    store.endSession("session");
    assert.equal(store.feed(uart, Buffer.from('v={"n":22}\n')).length, 0);
});

test("Mixed UART/RTT recording identifies the transport and endpoint in JSONL and CSV", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "json-uart-"));
    try {
        const store = new RttWatchStore();
        const frames = [rtt, uart].map(source => store.feed(source, Buffer.from('v={"n":1,"enabled":true}\n'))[0]);
        for (const format of ["jsonl", "csv"] as const) {
            const file = path.join(directory, `mixed.${format}`);
            const recording = await RttWatchRecording.create(file, format, store.leaves, () => {});
            frames.forEach(frame => recording.record(frame));
            await recording.stop();
            const content = fs.readFileSync(file, "utf8");
            if (format === "jsonl") {
                const rows = content.trim().split("\n").map(line => JSON.parse(line));
                assert.deepEqual(rows.map(row => row.source.transport), ["RTT", "UART"]);
                assert.equal(rows[1].source.port, uart.port);
                assert.deepEqual(Object.values(rows[1].values), [1, true]);
            } else {
                assert(content.startsWith('"Timestamp","Session","Transport","Endpoint","Watch"'));
                assert(content.includes('"UART","/dev/ttyUSB0","v"'));
                assert(content.includes('"RTT","0","v"'));
            }
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI holds slow JSON fragments until newline while ordinary UART prompts flush on idle", async () => {
    const output: string[] = [];
    const buffer = new LineBuffer("[UART]", (_prefix, line) => output.push(line), 5, true);
    buffer.push('telemetry={"rpm":');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(output, []);
    buffer.push('4000}\r\n');
    assert.deepEqual(output, ['telemetry={"rpm":4000}']);
    buffer.push('Press Enter: ');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(output[1], 'Press Enter: ');
    buffer.flush();
});

test("Same UART device path on different probe hosts stays isolated in one debug session", () => {
    const store = new RttWatchStore();
    store.feed({ ...uart, host: "host-one" }, Buffer.from('v={"n":1}\n'));
    store.feed({ ...uart, host: "host-two" }, Buffer.from('v={"n":2}\n'));
    assert.equal(store.roots.length, 2);
    assert.equal(new Set(store.leaves.map(n => n.key)).size, 2);
});
