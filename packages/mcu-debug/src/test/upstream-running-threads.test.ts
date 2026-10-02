import test from "node:test";
import assert from "node:assert/strict";
import { GDBDebugSession } from "../adapter/gdb-session";

for (const [label, info, expected] of [
    ["before any stop", undefined, [{ id: 1, name: "main" }]],
    ["with known threads", { currentThreadId: 7, getSortedThreadList: () => [{ id: 7, name: "control" }, { id: 9, target_id: "worker" }] }, [{ id: 7, name: "control" }, { id: 9, name: "worker" }]],
] as const) {
    test(`running target retains a Pause-capable thread list ${label}`, async () => {
        const session = Object.create(GDBDebugSession.prototype);
        session.isBusy = () => true;
        session.lastThreadsInfo = info;
        let sent: unknown;
        session.sendResponse = (response: unknown) => { sent = response; };
        session.gdbMiCommands = { sendThreadInfoAll: () => { throw new Error("Must not query running target"); } };
        const response = {};
        await session.threadsRequest(response);
        assert.equal(sent, response);
        assert.deepEqual((response as any).body.threads, expected);
    });
}
