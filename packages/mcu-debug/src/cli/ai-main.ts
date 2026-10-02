import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { SessionRegistry, selectSession } from "../common/session-registry";
import { getHelperExecutable } from "../adapter/servers/common";

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === "sessions" || args[0] === "list") {
        const records = new SessionRegistry().list();
        if (args.includes("--json")) process.stdout.write(JSON.stringify(records, null, 2) + "\n");
        else {
            process.stdout.write("MCU AI Debug CLI sessions\n");
            for (const record of records) process.stdout.write(`${record.id}\t${record.kind}\t${record.status}\t${record.config}\t${record.cwd}\twindow=${record.windowId ?? record.pid}\n`);
            if (!records.length) process.stdout.write("No active sessions.\n");
        }
        return;
    }
    if (args[0] === "attach" || args[0] === "manual") {
        const manual = args[0] === "manual";
        if (args.includes("--help") || args.includes("-h")) {
            process.stdout.write(
                manual
                    ? "Usage: mcu-ai-debug manual [run|start|wait|status|stop] [--session ID] [-s SOCKET]\nrun waits for Start, streams GDB/RTT/UART and accepts GDB commands and !!send [stream] input until the user clicks Stop.\nstart returns after approval; wait/stop waits for the same user's Stop. Cancellation exits with code 2.\n"
                    : "MCU AI Debug CLI\nUsage: mcu-ai-debug attach [--session ID] [-s SOCKET]\nUses a unique workspace session; ambiguous matches require --session.\nDisconnecting leaves an F5 session running.\n",
            );
            return;
        }
        const explicitAction = manual && args[1] && !args[1].startsWith("-");
        const action = manual ? (explicitAction ? args[1] : "run") : undefined;
        if (manual && !["run", "start", "stop", "wait", "status"].includes(action ?? ""))
            throw new Error("Use mcu-ai-debug manual [run|start|wait|status|stop] --session ID. Manual does not record Live Watch.");
        let id: string | undefined, endpoint: string | undefined;
        for (let i = manual && explicitAction ? 2 : 1; i < args.length; i++) {
            if (["--session", "-s", "--socket-path"].includes(args[i])) {
                const option = args[i],
                    value = args[++i];
                if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}`);
                if (option === "--session") id = value;
                else endpoint = value;
            } else throw new Error(`Unknown attach option: ${args[i]}`);
        }
        if (id && endpoint) throw new Error("Use --session or --socket-path, not both");
        if (!endpoint) {
            const records = new SessionRegistry().list();
            if (!id && !records.length && fs.existsSync(".mcu-debug/socket.json")) {
                const legacy = JSON.parse(fs.readFileSync(".mcu-debug/socket.json", "utf8"));
                endpoint = legacy.socket ?? legacy.pipe;
            } else {
                const record = selectSession(records, id, process.cwd());
                endpoint = record.socket ?? record.pipe;
            }
        }
        if (!endpoint) throw new Error("No session endpoint");
        const socket = net.connect(endpoint);
        const requestId = randomUUID();
        let answered = false;
        const interactive = manual && action === "run";
        if (manual) {
            let manualId: string | undefined;
            const ended = new Map<string, { status: string }>();
            const exitFor = (result: { status?: string; error?: string }) =>
                result.error || result.status === "SESSION_ENDED" ? 1 : ["USER_CONFIRMED", "USER_STOPPED"].includes(result.status ?? "") ? 0 : 2;
            const lines = createInterface({ input: socket, crlfDelay: Infinity });
            lines.on("line", (line) => {
                let result;
                try {
                    result = JSON.parse(line);
                } catch {
                    return;
                }
                if (interactive && (manualId || result.requestId === requestId)) process.stdout.write(line + "\n");
                if (result.event === "manual-state" && result.state === "ended") {
                    ended.set(result.manualId, result);
                    if (ended.size > 16) ended.delete(ended.keys().next().value!);
                    if (interactive && manualId === result.manualId) {
                        process.stdin.unpipe(socket);
                        process.stdin.pause();
                        process.exitCode = exitFor(result);
                        socket.end();
                    }
                }
                if (answered || result.requestId !== requestId) return;
                answered = true;
                if (!interactive) process.stdout.write(line + "\n");
                if (interactive && result.state === "active" && !result.error) {
                    manualId = result.manualId;
                    const finished = ended.get(manualId!);
                    if (finished) {
                        process.exitCode = exitFor(finished);
                        socket.end();
                    } else process.stdin.pipe(socket, { end: false }); // Keep RTT flowing after a piped command batch ends.
                } else {
                    process.exitCode = action === "status" && !result.error ? 0 : exitFor(result);
                    socket.end();
                }
            });
            socket.once("close", () => {
                lines.close();
                if ((!answered || (interactive && manualId && !ended.has(manualId))) && !process.exitCode) {
                    process.stderr.write("Session disconnected before manual interaction completed\n");
                    process.exitCode = 1;
                }
            });
        }
        socket.on("error", (error) => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        });
        socket.on("connect", () => {
            if (manual) socket.write(`!!manual ${interactive ? "start" : action} --request-id ${requestId}\n`);
            else {
                process.stdin.pipe(socket);
                socket.pipe(process.stdout, { end: false });
            }
        });
        socket.on("close", () => {
            process.stdin.unpipe(socket);
            process.stdin.pause();
        });
        process.once("SIGINT", () => socket.end()); // detach, never interrupt the target implicitly
        return;
    }
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
        process.stdout.write(
            "MCU AI Debug CLI\nUsage: mcu-ai-debug <debug|attach|sessions|manual|proxy>\n  sessions [--json]       List all VS Code / CLI sessions\n  attach --session ID    Join a fixed session\n  manual [run|start|wait|status|stop] --session ID\n                          Human Start -> CLI GDB/RTT/UART -> user Stop\n  debug -c CONFIG        Start an independent session (existing MCU-Debug options)\n",
        );
        return;
    }
    // Keep the upstream native debug/TUI/proxy command mapping and lifecycle intact.
    const child = spawn(getHelperExecutable(path.resolve(__dirname, "..")), args, {
        stdio: "inherit",
        argv0: "mcu-ai-debug",
    });
    child.once("error", (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
}
main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
