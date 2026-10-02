import { NotesManager } from "../cli/notes";
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { SessionRegistry } from "../common/session-registry";
import { SessionSocket } from "../common/session-socket";
import { sessionTelemetry, SessionTelemetry } from "../common/session-telemetry";
import { sendToStream, StreamSink } from "../common/send-to-stream";
import { CDebugSession } from "../common/cli-session";
import { LiveWatchTreeProvider } from "./views/live-watch";
import { ManualLoop } from "./manual-loop";
import { SerialPortView } from "./serial-view";

type Binding = { session: vscode.DebugSession; socket: SessionSocket; abort: AbortController };

export class F5SessionBridge implements vscode.Disposable {
    private readonly bindings = new Map<string, Binding>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly manual: ManualLoop;
    private readonly ready = new vscode.EventEmitter<SessionSocket>();
    public readonly onSessionReady = this.ready.event;
    private readonly windowId = randomUUID();
    private readonly notes = new Map<string, NotesManager>();
    public get sessions(): vscode.DebugSession[] { return [...this.bindings.values()].map(binding => binding.session); }
    public get hasSessions(): boolean {
        return this.bindings.size > 0;
    }
    public get windowIdentity(): string {
        return this.windowId;
    }
    private uiReady?: Promise<void>;
    private uiSocket?: SessionSocket;
    private uiAbort = new AbortController();
    private readonly decoderStates = new Map<string, { decoder: StringDecoder; pending: string }>();
    constructor(private readonly provider: LiveWatchTreeProvider) {
        this.manual = new ManualLoop((state) => {
            const binding = [...this.bindings.values()].find((entry) => entry.socket.record.id === state.ownerId);
            (binding?.socket ?? this.uiSocket)?.publish({ source: "DA", command: "manual", event: "manual-state", message: `Manual interaction: ${state.status}`, ...state });
        });
        this.subscriptions.push(
            vscode.debug.registerDebugAdapterTrackerFactory("mcu-debug", {
                createDebugAdapterTracker: (session) => {
                    const binding = this.bind(session);
                    return {
                        onDidSendMessage: (message) => this.event(binding, message),
                        onWillStopSession: () => this.end(session.id),
                        onError: () => this.end(session.id),
                        onExit: () => this.end(session.id),
                    };
                },
            }),
            vscode.debug.onDidStartDebugSession((session) => {
                if (session.type === "mcu-debug") this.bind(session);
            }),
            vscode.debug.onDidTerminateDebugSession((session) => this.end(session.id)),
        );
        sessionTelemetry.on("data", this.telemetry);
        sessionTelemetry.on("source-end", this.sourceEnded);
    }
    private bind(session: vscode.DebugSession): Binding {
        const existing = this.bindings.get(session.id);
        if (existing) return existing;
        const registry = new SessionRegistry();
        const record = registry.create({
            kind: "f5",
            cwd: session.workspaceFolder?.uri.fsPath ?? session.configuration.cwd ?? process.cwd(),
            config: session.name,
            windowId: this.windowId,
            executable: session.configuration.executable,
        });
        const abort = new AbortController();
        const socket: SessionSocket = new SessionSocket(record, (line, reply, signal) => this.command(session, socket, abort.signal, signal, line, reply), registry);
        const binding = { session, socket, abort };
        this.bindings.set(session.id, binding);
        if (session.configuration.pvtSerialSessionToken) SerialPortView.bindSession(session.id, session.configuration.pvtSerialSessionToken);
        socket
            .start()
            .then(() => {
                if (!abort.signal.aborted) this.ready.fire(socket);
            })
            .catch((error) => vscode.window.showWarningMessage(`MCU AI Debug CLI session interface failed: ${error}`));
        return binding;
    }
    private event(binding: Binding, message: any): void {
        if (message.type !== "event" || binding.abort.signal.aborted) return;
        switch (message.event) {
            case "stopped":
                binding.socket.update("paused", message.body?.reason ?? "");
                break;
            case "continued":
                binding.socket.update("running");
                break;
            case "initialized":
                binding.socket.update("initialized");
                break;
            case "terminated":
                this.end(binding.session.id);
                break;
            case "custom-event-ai-server-output":
                binding.socket.publish({ source: "GDB-SERVER", message: message.body?.info?.message ?? "" });
                break;
            case "output":
                binding.socket.publish({
                    source: "GDB",
                    category: message.body?.category,
                    message: message.body?.output ?? "",
                });
                break;
        }
    }
    private telemetryKey(packet: Omit<SessionTelemetry, "data">): string {
        return `${packet.sessionId}:${packet.source}:${JSON.stringify([packet.channel, packet.host, packet.port, packet.prefix])}`;
    }
    private readonly sourceEnded = (packet: Omit<SessionTelemetry, "data">): void => {
        this.decoderStates.delete(this.telemetryKey(packet));
    };
    private readonly telemetry = (packet: SessionTelemetry) => {
        const binding = this.bindings.get(packet.sessionId);
        if (!binding) return;
        const key = this.telemetryKey(packet);
        let state = this.decoderStates.get(key);
        if (!state) {
            state = { decoder: new StringDecoder("utf8"), pending: "" };
            this.decoderStates.set(key, state);
        }
        state.pending += state.decoder.write(packet.data);
        const lines = state.pending.split(/\r?\n/);
        state.pending = lines.pop()!;
        // Bound partial firmware output while retaining complete JSON records on the AI wire.
        if (state.pending.length > 65536) {
            lines.push(state.pending.slice(0, 65536));
            state.pending = "";
        }
        for (const line of lines)
            binding.socket.publish({
                source: packet.source,
                prefix: packet.prefix,
                port: packet.port,
                host: packet.host,
                channel: packet.channel,
                message: `${packet.prefix} ${line}`,
            });
    };
    private sinks(session: vscode.DebugSession): StreamSink[] {
        const current = CDebugSession.FindSession(session);
        const rtts = Object.entries(current?.rttPortMap ?? {}).map(([channel, source]) => {
            const decoder = session.configuration.rttConfig?.decoders?.find((candidate: any) => Number(candidate.port) === Number(channel));
            return {
                prefix: `[${String(decoder?.label ?? `RTT#${channel}`).replace(/^\[|\]$/g, "")}]`,
                write: (text: string) => {
                    if (!source.connected) return false;
                    source.write(`${text}\r\n`);
                    return true;
                },
            };
        });
        return [...rtts, ...SerialPortView.sinksForSession(session.id)];
    }
    private async command(
        session: vscode.DebugSession | undefined,
        socket: SessionSocket,
        ownerSignal: AbortSignal,
        clientSignal: AbortSignal,
        input: string,
        reply: (message: object) => void,
    ): Promise<void> {
        const signal = AbortSignal.any([ownerSignal, clientSignal]);
        if (signal.aborted) throw new Error("Session ended");
        const trimmed = input.trim(),
            lower = trimmed.toLowerCase();
        const result = (command: string, data: object) => reply({ source: "DA", command, message: `${command} result`, ...data });
        socket.publish({ source: "socket-input", message: input });
        if (lower.startsWith("!!livewatch")) {
            if (!session) throw new Error("Independent CLI sessions have no Live Watch panel; attach to its F5 session");
            const match = /^!!livewatch\s+(read|add|remove)(?:\s+([\s\S]*))?$/i.exec(trimmed);
            if (!match) throw new Error("Use !!livewatch read|add|remove");
            const action = match[1].toLowerCase();
            if (action === "read") result("livewatch", this.provider.getCachedPanelSnapshot(session.id));
            else {
                const args = JSON.parse(match[2] ?? "{}");
                if (args.userRequested !== true) throw new Error("Live Watch changes require an explicit user request (userRequested: true)");
                result("livewatch", await this.provider.changePanelExpression(session.id, action, args.expression));
            }
            return;
        }
        if (lower.startsWith("!!manual")) {
            const match = /^!!manual\s+(start|stop|wait|status)(?:\s+--request-id\s+([a-zA-Z0-9-]+))?(?:\s+--owner-id\s+([a-zA-Z0-9-]+))?$/i.exec(trimmed);
            if (!match) throw new Error("Use !!manual start|wait|status|stop. Manual has no Live Watch recording mode.");
            const action = match[1].toLowerCase(),
                requestId = match[2];
            try {
                const record = session ? socket.record : new SessionRegistry().list().find((entry) => entry.id === match[3] && entry.kind === "cockpit" && entry.windowId === this.windowId);
                if (!record) throw new Error("No matching Cockpit owner in this VS Code window");
                const state =
                    action === "start"
                        ? await this.manual.start(record.id, record.config, session ? ownerSignal : signal, clientSignal)
                        : action === "status"
                          ? this.manual.status(record.id)
                          : await this.manual.wait(record.id, signal);
                result("manual", { requestId, action, ...state });
            } catch (error) {
                result("manual", { requestId, level: "error", error: "command-failed", detail: String(error) });
            }
            return;
        }
        if (!session) throw new Error("This endpoint only handles manual UI requests");
        if (lower.startsWith("!!note:")) {
            let notes = this.notes.get(session.id);
            if (!notes) {
                notes = new NotesManager(socket.record.started, socket.record.cwd);
                this.notes.set(session.id, notes);
            }
            const patches = JSON.parse(trimmed.slice("!!NOTE:".length));
            if (!Array.isArray(patches)) throw new Error("Notes must be a JSON Patch array");
            notes.applyPatches(session.name, patches);
            result("note", { status: "OK" });
            return;
        }
        if (lower === "status" || lower === "!!status") {
            result("status", { ...socket.record, rtts: this.sinks(session).map((sink) => ({ prefix: sink.prefix })) });
            return;
        }
        if (/^!!send(?:\s|$)/i.test(trimmed)) {
            const payload = input.trimStart().slice(6).replace(/^\s/, "");
            sendToStream(payload, this.sinks(session), (message) => socket.publish(message));
            return;
        }
        if (lower.startsWith("!!ai-request:") || lower === "!!ai-request-clear" || lower.startsWith("!!ai ")) {
            socket.publish({
                source: lower.startsWith("!!ai ") ? "USER-REQUEST" : "AI",
                message: lower.startsWith("!!ai ") ? trimmed.slice(5) : trimmed,
            });
            return;
        }
        // Same upstream meta-command mapping. Ordinary commands remain REPL evaluate -> GDB/MI.
        const requests: Record<string, [string, any]> = {
            pause: ["pause", { threadId: 1 }],
            "!!sigint": ["pause", { threadId: 1 }],
            continue: ["continue", { threadId: 1 }],
            c: ["continue", { threadId: 1 }],
            cont: ["continue", { threadId: 1 }],
            reset: ["reset-device", "reset"],
            "!!reset": ["reset-device", "reset"],
            restart: ["restart", {}],
            "!!restart": ["restart", {}],
        };
        if (lower === "exit") {
            await vscode.debug.stopDebugging(session);
            return;
        }
        if (trimmed.startsWith("!!") && !requests[lower]) throw new Error(`Unknown meta-command: ${trimmed}`);
        if (!trimmed) return;
        const request = requests[lower];
        await session.customRequest(request?.[0] ?? "evaluate", request?.[1] ?? { expression: trimmed, context: "repl" });
    }
    public async getUiEndpoint(): Promise<string> {
        if (!this.uiSocket) {
            const record = new SessionRegistry().create({ kind: "cockpit", cwd: process.cwd(), config: "Cockpit UI" });
            const socket: SessionSocket = new SessionSocket(record, (line, reply, signal) => this.command(undefined, socket, this.uiAbort.signal, signal, line, reply), undefined, false);
            this.uiSocket = socket;
            this.uiReady = socket.start();
        }
        await this.uiReady;
        return this.uiSocket!.endpoint;
    }
    public async chooseSession(currentOnly = false): Promise<SessionSocket | undefined> {
        const active = vscode.debug.activeDebugSession;
        if (currentOnly && active?.type === "mcu-debug") return this.bindings.get(active.id)?.socket;
        const choices = [...this.bindings.values()].map((binding) => ({
            label: binding.session.name,
            description: binding.socket.record.cwd,
            detail: `${binding.socket.record.id} | ${binding.socket.record.status}`,
            binding,
        }));
        const selected = await vscode.window.showQuickPick(choices, {
            title: "MCU AI Debug CLI: select an F5 session",
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return selected?.binding.socket;
    }
    private end(id: string): void {
        const binding = this.bindings.get(id);
        if (!binding) return;
        binding.abort.abort();
        this.notes.get(id)?.flushNow();
        this.notes.delete(id);
        binding.socket.update("terminated");
        binding.socket.dispose();
        this.bindings.delete(id);
        for (const key of this.decoderStates.keys()) if (key.startsWith(`${id}:`)) this.decoderStates.delete(key);
        SerialPortView.unbindSession(id);
    }
    dispose(): void {
        for (const id of this.bindings.keys()) this.end(id);
        this.manual.dispose();
        this.ready.dispose();
        this.uiAbort.abort();
        this.uiSocket?.dispose();
        sessionTelemetry.off("data", this.telemetry);
        sessionTelemetry.off("source-end", this.sourceEnded);
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }
}
