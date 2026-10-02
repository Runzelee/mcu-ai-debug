import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Transport from "winston-transport";
import { CliSessionDriver } from "../cli/cli-driver";
import { logger } from "../common/logger";
import { ManualSessionManager } from "../common/manual-session";
import { SessionRegistry } from "../common/session-registry";
import { SessionSocket } from "../common/session-socket";

test("independent CLI relays Start and the owner's Stop over its existing UI socket, without starting GDB", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-manual-relay-"));
    const registry = new SessionRegistry(directory);
    const owner = registry.create({ kind: "cockpit", cwd: directory, config: "Independent MCU", windowId: "window" });
    const output: any[] = [], inputs: string[] = [];
    class Capture extends Transport {
        log(info: any, done: () => void) { output.push({ ...info }); done(); }
    }
    const capture = new Capture();
    logger.add(capture);
    let stop!: (approved: boolean) => void;
    const manager = new ManualSessionManager(async (_name, button) => button === "Start" || await new Promise<boolean>((resolve) => { stop = resolve; }), (state) => server.publish({ source: "DA", command: "manual", event: "manual-state", message: state.status, ...state }));
    const server = new SessionSocket(registry.create({ kind: "cockpit", cwd: directory, config: "UI" }), async (line, reply, signal) => {
        inputs.push(line);
        const match = /^!!manual start --request-id (\S+) --owner-id (\S+)$/.exec(line)!;
        assert.equal(match[2], owner.id);
        reply({ source: "DA", command: "manual", requestId: match[1], message: "manual result", ...await manager.start(owner.id, owner.config, signal, signal) });
    }, registry, false);
    // Test the actual command handler with no driver startup, probe, adapter, or telemetry side effects.
    const driver = Object.create(CliSessionDriver.prototype) as any;
    driver.registryRecord = owner;
    driver.manualUiClients = new Set();
    const previous = process.env.MCU_AI_DEBUG_UI_SOCKET;
    const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error("Manual relay timeout");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    try {
        await server.start();
        process.env.MCU_AI_DEBUG_UI_SOCKET = server.endpoint;
        assert.equal(driver.handleSpecialCommands("!!manual start --request-id relay-1", false, "!!manual start --request-id relay-1"), true);
        await until(() => output.some((record) => record.requestId === "relay-1" && record.state === "active"));
        assert.equal(inputs.length, 1);
        const state = manager.status(owner.id);
        assert("manualId" in state);
        const manualId = state.manualId;
        const count = output.length;
        server.publish({ command: "manual", event: "manual-state", ownerId: "other-window", manualId, state: "ended", status: "USER_STOPPED" });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(output.length, count);
        assert.equal(driver.manualUiClients.size, 1);
        stop(true);
        await until(() => output.some((record) => record.event === "manual-state" && record.ownerId === owner.id && record.status === "USER_STOPPED"));
        await until(() => driver.manualUiClients.size === 0);
    } finally {
        if (previous === undefined) delete process.env.MCU_AI_DEBUG_UI_SOCKET;
        else process.env.MCU_AI_DEBUG_UI_SOCKET = previous;
        for (const socket of driver.manualUiClients) socket.destroy();
        manager.dispose();
        server.dispose();
        logger.remove(capture);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
