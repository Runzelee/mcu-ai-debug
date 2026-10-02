import test from "node:test";
import assert from "node:assert/strict";
import { ManualSessionManager, ManualState } from "../common/manual-session";

test("manual approval shows Stop and survives one-shot CLI detachment", async () => {
    const states: ManualState[] = [];
    let stop!: (approved: boolean) => void;
    const manager = new ManualSessionManager(
        async (_name, button) =>
            button === "Start" ||
            (await new Promise<boolean>((resolve) => {
                stop = resolve;
            })),
        (state) => states.push(state),
    );
    const owner = new AbortController(),
        client = new AbortController();
    const started = await manager.start("f5-a", "STM32", owner.signal, client.signal);
    assert.equal(started.status, "USER_CONFIRMED");
    client.abort();
    assert.equal(manager.status("f5-a").state, "active");
    await assert.rejects(manager.start("f5-a", "STM32", owner.signal, new AbortController().signal), /already pending/);
    const done = manager.wait("f5-a", new AbortController().signal);
    stop(true);
    assert.equal((await done).status, "USER_STOPPED");
    assert.deepEqual(
        states.map((state) => state.state),
        ["waiting", "active", "ended"],
    );
    assert.equal((await manager.wait("f5-a", owner.signal)).status, "USER_STOPPED");
    manager.dispose();
});

test("cancelled Start never creates an active interaction", async () => {
    const states: ManualState[] = [];
    const manager = new ManualSessionManager(
        async () => false,
        (state) => states.push(state),
    );
    const signal = new AbortController().signal;
    assert.equal((await manager.start("a", "MCU", signal, signal)).status, "CANCELLED_BY_USER");
    assert(!states.some((state) => state.state === "active"));
    manager.dispose();
});

test("ending one debug owner leaves other windows' manual interactions active", async () => {
    const manager = new ManualSessionManager(
        async (_name, button, signal) => button === "Start" || (await new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }))),
        () => {},
    );
    const a = new AbortController(),
        b = new AbortController(),
        client = new AbortController();
    await manager.start("window-a", "MCU", a.signal, client.signal);
    await manager.start("window-b", "MCU", b.signal, client.signal);
    a.abort();
    assert.equal(manager.status("window-a").status, "SESSION_ENDED");
    assert.equal(manager.status("window-b").state, "active");
    manager.dispose();
});

test("a disconnected wait client does not end the human-owned interaction", async () => {
    let stop!: (accepted: boolean) => void;
    const manager = new ManualSessionManager(
        async (_name, button) =>
            button === "Start" ||
            (await new Promise<boolean>((resolve) => {
                stop = resolve;
            })),
        () => {},
    );
    const owner = new AbortController(),
        client = new AbortController();
    await manager.start("a", "MCU", owner.signal, owner.signal);
    const wait = manager.wait("a", client.signal);
    client.abort();
    await assert.rejects(wait, /disconnected/);
    assert.equal(manager.status("a").state, "active");
    stop(true);
    assert.equal((await manager.wait("a", owner.signal)).status, "USER_STOPPED");
    manager.dispose();
});
