import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { AISessionRecord, SessionRegistry } from "./session-registry";

export class SessionSocket {
    private readonly clients = new Set<net.Socket>();
    private readonly history: string[] = [];
    private historyBytes = 0;
    private server?: net.Server;
    private closed = false;
    private ready = false;
    public readonly endpoint: string;
    constructor(
        public readonly record: AISessionRecord,
        private readonly command: (
            line: string,
            reply: (message: object) => void,
            signal: AbortSignal,
        ) => Promise<void>,
        private readonly registry = new SessionRegistry(),
        private readonly advertise = true,
    ) {
        this.endpoint =
            process.platform === "win32"
                ? `\\\\.\\pipe\\mcu-ai-debug-${record.id}`
                : `${os.tmpdir()}/mcu-ai-${record.id}.sock`;
        if (process.platform === "win32") record.pipe = this.endpoint;
        else record.socket = this.endpoint;
    }
    async start(): Promise<void> {
        this.server = net.createServer((socket) => {
            const abort = new AbortController();
            this.clients.add(socket);
            socket.on("error", () => socket.destroy());
            socket.on("close", () => {
                abort.abort();
                this.clients.delete(socket);
            });
            socket.write(this.history.join(""));
            socket.write(
                this.encode({
                    source: "DA",
                    message: `Session summary: ${JSON.stringify(this.record)}`,
                    ...this.record,
                }),
            );
            const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
            lines.on("line", (line) => {
                if (line.length > 65536) {
                    socket.destroy(new Error("Command too long"));
                    return;
                }
                const reply = (message: object) => {
                    if (!socket.destroyed) this.write(socket, this.encode(message));
                };
                // The debug adapter serializes GDB requests. UI prompts must not block other commands/clients.
                Promise.resolve()
                    .then(() => this.command(line, reply, abort.signal))
                    .catch((error) =>
                        reply({ source: "DA", level: "error", error: "command-failed", message: String(error) }),
                    );
            });
            socket.on("close", () => lines.close());
            // Bound an unterminated command too; readline otherwise retains arbitrary input.
            let pendingBytes = 0;
            socket.on("data", (data) => {
                const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const last = bytes.lastIndexOf(10);
                pendingBytes = last < 0 ? pendingBytes + bytes.length : bytes.length - last - 1;
                if (pendingBytes > 65536) socket.destroy(new Error("Command too long"));
            });
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(this.endpoint, () => {
                try {
                    if (process.platform !== "win32") fs.chmodSync(this.endpoint, 0o600);
                    if (this.closed) {
                        this.dispose();
                        resolve();
                        return;
                    }
                    if (this.advertise) this.registry.write(this.record);
                    this.ready = true;
                    resolve();
                } catch (error) {
                    this.dispose();
                    reject(error);
                }
            });
        });
    }
    private encode(message: object): string {
        return JSON.stringify({ level: "info", timestamp: new Date().toISOString(), ...message }) + "\n";
    }
    private write(socket: net.Socket, line: string): void {
        if (socket.writableLength + Buffer.byteLength(line) > 1024 * 1024) {
            socket.destroy(new Error("Client cannot keep up"));
            return;
        }
        socket.write(line);
    }
    publish(message: object): void {
        if (this.closed) return;
        const line = this.encode(message);
        if (Buffer.byteLength(line) <= 65536) {
            this.history.push(line);
            this.historyBytes += Buffer.byteLength(line);
            while (this.historyBytes > 65536) this.historyBytes -= Buffer.byteLength(this.history.shift()!);
        }
        for (const socket of this.clients) this.write(socket, line);
    }
    update(status: string, reason = ""): void {
        if (this.closed) return;
        this.record.status = status;
        if (this.advertise && this.ready) this.registry.write(this.record);
        this.publish({ source: "DA", status, reason, message: `status: ${status}` });
    }
    dispose(): void {
        this.closed = true;
        for (const socket of this.clients) {
            socket.end();
            const timer = setTimeout(() => socket.destroy(), 1000);
            timer.unref();
            socket.once("close", () => clearTimeout(timer));
        }
        this.clients.clear();
        this.server?.close();
        if (this.advertise) this.registry.remove(this.record.id);
        if (process.platform !== "win32") fs.rmSync(this.endpoint, { force: true });
    }
}
