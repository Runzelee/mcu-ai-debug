import * as net from "net";
import { GDBDebugSession } from "./gdb-session";
import { GDBServerSession } from "./server-session";
import { ConfigurationArguments } from "./servers/common";
import { existsSync } from "fs";
import { DebugHelper } from "./helper";
import { Stderr, Stdout } from "./gdb-mi/mi-types";
import { spawn } from "child_process";

export class ProxyClient {
    private args: ConfigurationArguments;
    private socket: net.Socket | null = null;
    constructor(
        private session: GDBDebugSession,
        private serverSession: GDBServerSession,
    ) {
        this.args = session.args;
    }

    async start() {
        this.args = this.session.args;
        if (!this.args.hostConfig || !this.args.hostConfig.sshHost) {
            return;
        }
        const remoteHost = this.args.hostConfig.remoteHost || "127.0.0.1";
        const remotePort = this.args.hostConfig.remotePort || 4567;
        if (!(await this.connectToProxy(remoteHost, remotePort))) {
            if (this.args.hostConfig.type === "local") {
                await this.startProxy(remoteHost, remotePort);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                if (!(await this.connectToProxy(remoteHost, remotePort))) {
                    this.session.handleMsg(Stderr, `Failed to connect to proxy on ${remoteHost}:${remotePort}`);
                } else {
                    this.session.handleMsg(Stdout, `Connected to proxy on ${remoteHost}:${remotePort}`);
                }
            } else {
                this.session.handleMsg(Stderr, `Failed to connect to proxy on ${remoteHost}:${remotePort}. Please ensure the proxy is running.`);
            }
        }
    }

    private async startProxy(host: string, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const helper = new DebugHelper(this.session);
            const path = helper.getHelperExecPath();
            if (!path || !existsSync(path)) {
                this.session.handleMsg(Stderr, `Proxy helper executable not found at ${path}`);
                reject(new Error("Proxy helper executable not found"));
                return;
            }
            try {
                const proxyProcess = spawn(path, ["--host", host, "--port", port.toString()], {
                    detached: true,
                    stdio: "ignore",
                });
                proxyProcess.on("spawn", () => {
                    this.session.handleMsg(Stdout, `Proxy helper started on ${host}:${port}`);
                    resolve();
                });
                proxyProcess.on("error", (err) => {
                    this.session.handleMsg(Stderr, `Failed to start proxy helper: ${err}`);
                    reject(err);
                });
                proxyProcess.unref();
            } catch (err) {
                this.session.handleMsg(Stderr, `Failed to start proxy helper: ${err}`);
                reject(err);
            }
        });
    }

    private connectToProxy(host: string, port: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.once("connect", () => {
                this.socket = socket;
                resolve(true);
            });
            socket.once("error", () => {
                resolve(false);
            });
            socket.connect(port, host);
        });
    }
}
