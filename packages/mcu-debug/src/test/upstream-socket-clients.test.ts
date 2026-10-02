import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { CliSessionDriver } from "../cli/cli-driver";
import { CustomTransport } from "../common/logger";

async function until(check: () => boolean) {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("Socket test timed out");
}
test("independent CLI clients each receive output; one disconnect cannot detach the other", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-clients-"));
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\mcu-clients-${process.pid}` : path.join(root, "test.sock");
    const driver = Object.create(CliSessionDriver.prototype);
    driver.checkSocketFree = async () => {};
    driver.createSocketPath = () => socket;
    driver.writeSockFile = () => {};
    driver.cliArgs = { waitForClient: false };
    driver.serverClients = new Set();
    driver.clientSeq = 0;
    Object.defineProperty(driver, "stdinIsPilot", {value: true});
    driver.customTransport = new CustomTransport({callback: () => {}});
    let first: net.Socket | undefined, second: net.Socket | undefined;
    try {
        await driver.startSocketReader();
        first = net.createConnection(socket); await once(first, "connect");
        second = net.createConnection(socket); await once(second, "connect");
        let a = "", b = "";
        first.on("data", chunk => { a += chunk; }); second.on("data", chunk => { b += chunk; });
        await until(() => driver.serverClients.size === 2);
        driver.customTransport.log({[Symbol.for("message")]: "both-clients"}, () => {});
        await until(() => a.includes("both-clients") && b.includes("both-clients"));
        first.destroy(); await until(() => driver.serverClients.size === 1);
        driver.customTransport.log({[Symbol.for("message")]: "surviving-client"}, () => {});
        await until(() => b.includes("surviving-client"));
        assert(!a.includes("surviving-client"));
    } finally {
        first?.destroy(); second?.destroy();
        await new Promise<void>(resolve => driver.server.close(resolve));
        driver.customTransport.destroy();
        fs.rmSync(root, {recursive: true, force: true});
    }
});
