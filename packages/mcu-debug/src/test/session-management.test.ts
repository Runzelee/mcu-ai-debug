import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { once } from "node:events";
import { SessionRegistry, selectSession } from "../common/session-registry";
import { SessionSocket } from "../common/session-socket";

test("global session registry isolates windows, requires explicit ambiguous selection, and removes stale records without attaching", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-ai-registry-"));
    try {
        const registry = new SessionRegistry(directory);
        const endpoint = path.join(directory, "socket");
        fs.writeFileSync(endpoint, "");
        const a = registry.create({
            kind: "f5",
            cwd: "/project",
            config: "same name",
            windowId: "window-a",
            socket: endpoint,
        });
        const b = registry.create({
            kind: "f5",
            cwd: "/project",
            config: "same name",
            windowId: "window-b",
            socket: endpoint,
        });
        const c = registry.create({ kind: "cli", cwd: "/other-project", config: "independent", socket: endpoint });
        [a, b, c].forEach((record) => registry.write(record));
        assert.equal(registry.list().length, 3);
        assert.throws(() => selectSession(registry.list(), undefined, "/project"), /Multiple sessions/);
        assert.equal(selectSession(registry.list(), a.id, "/elsewhere").windowId, "window-a");
        assert.equal(selectSession(registry.list(), undefined, "/other-project").id, c.id);
        assert.throws(() => selectSession(registry.list(), undefined, "/missing"), /No active session/);
        registry.write({ ...a, processStart: "definitely-not-current-process" });
        assert.equal(registry.list().length, 2);
        assert.equal(fs.existsSync(path.join(directory, `${a.id}.json`)), false);
        assert.throws(() => registry.remove("../foreign"), /Invalid session ID/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("two clients share one session and disconnect does not end F5; partial lines and request errors remain isolated", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-ai-socket-"));
    const registry = new SessionRegistry(directory);
    const record = registry.create({ kind: "f5", cwd: "/project", config: "F5" });
    const commands: string[] = [];
    let pendingSignal: AbortSignal | undefined;
    const server = new SessionSocket(
        record,
        async (line, reply, signal) => {
            commands.push(line);
            if (line === "pending") pendingSignal = signal;
            else if (line === "bad") throw new Error("target rejected");
            else reply({ command: line, value: 42 });
        },
        registry,
    );
    const clients: net.Socket[] = [];
    try {
        server.update("paused"); // Event before listen must not publish an invalid registry entry.
        assert.equal(registry.list().length, 0);
        await server.start();
        const a = net.connect(server.endpoint),
            b = net.connect(server.endpoint);
        clients.push(a, b);
        const output: string[] = [];
        b.on("data", (data) => output.push(data.toString()));
        a.resume();
        await Promise.all([once(a, "connect"), once(b, "connect")]);
        b.write("info ");
        b.write("registers\nbad\n");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(commands, ["info registers", "bad"]);
        assert.match(output.join(""), /target rejected/);
        a.write("pending\n");
        await new Promise((resolve) => setTimeout(resolve, 20));
        a.destroy();
        await once(a, "close");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(pendingSignal?.aborted, true);
        assert.equal(registry.list().length, 1);
        server.publish({ source: "RTT", message: "[buzzer_debug] value=7" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.match(output.join(""), /value=7/);
        for (const line of output.join("").trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
        server.update("terminated");
        server.dispose();
        await once(b, "close");
        assert.equal(registry.list().length, 0);
    } finally {
        clients.forEach((client) => client.destroy());
        server.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
