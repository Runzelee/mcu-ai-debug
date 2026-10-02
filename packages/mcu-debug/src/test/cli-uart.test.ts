import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { once } from "node:events";
import Transport from "winston-transport";
import { CLISerialPortView } from "../cli/cli-serial";
import { CliSessionDriver } from "../cli/cli-driver";
import { logger } from "../common/logger";
import { setHostAdapter } from "../common/host-adapter";

setHostAdapter({ debugMessage: () => {} } as any);
const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("UART CLI timeout");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

test("Standalone CLI routes UART !!send and decodes fragmented UTF-8 over the existing serial bridge", async () => {
    const records: any[] = [];
    class Capture extends Transport {
        log(info: any, done: () => void) { records.push({ ...info }); done(); }
    }
    const capture = new Capture(); logger.add(capture);
    let connection!: net.Socket, received = "";
    const server = net.createServer(socket => { connection = socket; socket.on("data", chunk => received += chunk.toString()); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as net.AddressInfo).port;
    const view = new CLISerialPortView("/dev/mock-uart", { label: "UART", input_mode: "cooked" } as any, false, port);
    try {
        await until(() => view.getStatus() === "connected");
        const driver = Object.create(CliSessionDriver.prototype) as any;
        driver.rtts = [];
        driver.adapter = { getSerialPortViews: () => [view] };
        driver.doSendToStream('[UART]   status  ');
        await until(() => received === '  status  \r\n');
        const bytes = Buffer.from('telemetry={"text":"蜂鸣器","rpm":4000}\r\n');
        const split = bytes.indexOf(Buffer.from('蜂')) + 1;
        connection.write(bytes.subarray(0, split));
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(records.filter(record => record.source === "serial").length, 0);
        connection.write(bytes.subarray(split));
        await until(() => records.some(record => record.source === "serial"));
        const sample = records.find(record => record.source === "serial");
        assert.equal(sample.message, '[UART] telemetry={"text":"蜂鸣器","rpm":4000}');
        assert.equal(sample.port, '/dev/mock-uart');
        connection.write('telemetry={"stale":');
        await new Promise(resolve => setTimeout(resolve, 30));
        view.notifyDisconnected("reconnect test");
        view.setTcpPort(port);
        await until(() => view.getStatus() === "connected");
        connection.write('{"fresh":true}\n');
        await until(() => records.filter(record => record.source === "serial").length === 2);
        assert.equal(records.filter(record => record.source === "serial")[1].message, '[UART] {"fresh":true}');
        view.dispose();
        driver.doSendToStream('[UART] blocked');
        assert(records.some(record => record.error === 'not-connected'));
        const replacement = new CLISerialPortView('/dev/second', { label: 'UART' } as any);
        assert.equal(replacement.getPrefix(), '[UART]', 'Closed ports release their labels');
        replacement.dispose();
    } finally {
        view.dispose(); connection?.destroy(); server.close(); await once(server, "close"); logger.remove(capture);
    }
});
