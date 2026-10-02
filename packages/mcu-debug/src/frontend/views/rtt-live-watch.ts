import * as vscode from "vscode";
import { sessionTelemetry, SessionTelemetry } from "../../common/session-telemetry";
import { CDebugSession } from "../../common/cli-session";
import { RttWatchStore, WatchFrame, WatchNode, WatchSource, watchSourceLabel } from "../../common/rtt-watch";
import { JSON_WATCH_FIRMWARE_PROMPT } from "../../common/rtt-watch-prompt";
import { RttWatchRecording } from "../../common/rtt-watch-capture";
import { EditableTreeViewProvider, TreeItem, TreeViewProviderDelegate } from "../webview_tree/editable-tree";
import { LiveWatchGrapher } from "./live-watch-grapher";

export class RttLiveWatchProvider implements TreeViewProviderDelegate, vscode.Disposable {
    public readonly store = new RttWatchStore();
    public readonly tree: EditableTreeViewProvider;
    public readonly grapher: LiveWatchGrapher;
    private readonly sessions = new Map<string, string>();
    private readonly expanded = new Map<string, boolean>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private schemaDirty = false;
    private readonly dirty = new Set<string>();
    private recording?: RttWatchRecording;
    private recordingFields: WatchNode[] = [];
    private recordingPending = false;
    private disposed = false;

    constructor(context: vscode.ExtensionContext) {
        this.tree = new EditableTreeViewProvider(context.extensionUri, this, { readOnly: true, copyFirmwarePrompt: true });
        this.grapher = new LiveWatchGrapher(context.extensionPath, { viewType: "mcu-ai-debug.rttLiveWatchGraph",
            title: "JSON Live Watch Graph", labelForKey: key => this.graphLabel(key), emptyMessage: "No numeric JSON values available. Print a JSON record on an enabled RTT channel or UART port first." });
        this.subscriptions.push(
            vscode.debug.onDidStartDebugSession(s => { if (s.type === "mcu-debug") this.sessions.set(s.id, s.name); }),
            vscode.debug.onDidTerminateDebugSession(s => {
                this.finishSession(s.id);
            }),
        );
        if (vscode.debug.activeDebugSession?.type === "mcu-debug") this.sessions.set(vscode.debug.activeDebugSession.id, vscode.debug.activeDebugSession.name);
        sessionTelemetry.on("data", this.receive);
        sessionTelemetry.on("end", this.finishSession);
        sessionTelemetry.on("source-end", this.finishSource);
        void vscode.commands.executeCommand("setContext", "mcu-ai-debug:isRttWatchRecording", false);
    }
    private readonly receive = (event: SessionTelemetry): void => {
        if ((event.source !== "RTT" && event.source !== "serial") || this.disposed) return;
        const source = this.telemetrySource(event);
        if (source) for (const frame of this.store.feed(source, event.data)) this.accept(frame);
    };
    private telemetrySource(event: Omit<SessionTelemetry, "data">): WatchSource | undefined {
        const session = CDebugSession.CurrentSessions.find(s => s.session.id === event.sessionId);
        const name = event.sessionName ?? this.sessions.get(event.sessionId) ?? session?.session.name;
        if (!name) return; // Never mix unrelated windows/sessions.
        return { sessionId: event.sessionId, sessionName: name, label: event.prefix,
            ...(event.source === "serial" ? { transport: "UART", port: event.port ?? event.prefix, host: event.host, hostName: event.hostName } : { transport: "RTT", channel: event.channel ?? 0 }) };
    }
    private readonly finishSource = (event: Omit<SessionTelemetry, "data">): void => {
        if (event.source !== "RTT" && event.source !== "serial") return;
        const source = this.telemetrySource(event);
        if (!source || this.disposed) return;
        this.store.endSource(source); this.schemaDirty = true; this.schedule();
        if (this.recordingFields.some(f => !this.store.isActive(f.sourceId))) void this.stopRecording();
    };
    private readonly finishSession = (sessionId: string): void => {
        this.sessions.delete(sessionId); this.store.endSession(sessionId); this.schemaDirty = true; this.schedule();
        if (this.recordingFields.some(f => this.store.source(f.sourceId)?.sessionId === sessionId)) void this.stopRecording();
    };
    private accept(frame: WatchFrame): void {
        this.schemaDirty ||= frame.structureChanged;
        for (const id of frame.nodes) this.dirty.add(id);
        this.dirty.add(frame.sourceId);
        const graph: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(frame.values)) if (typeof value === "number" || typeof value === "boolean") graph[key] = String(Number(value));
        this.grapher.pushData(frame.timestamp, graph);
        this.recording?.record(frame);
        this.schedule();
    }
    private schedule(): void {
        if (this.timer || this.disposed) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.schemaDirty) this.tree.refresh();
            else this.tree.updateComposite([...this.dirty].flatMap(id => { const n = this.store.nodes.get(id); return n ? [this.item(n)] : []; }));
            this.schemaDirty = false; this.dirty.clear();
        }, 100);
    }
    private item(node: WatchNode): TreeItem {
        const root = this.store.roots.some(n => n.id === node.id);
        const recording = this.recordingFields.some(f => f.id === node.id);
        return { id: node.id, label: node.label, value: root ? (this.store.isActive(node.id) ? "Receiving" : "Disconnected · last sample") : node.value,
            actualValue: node.value, readonly: true, hasChildren: node.children.length > 0,
            expanded: this.expanded.get(node.id) ?? node.path.length === 0, changed: node.changed,
            contextValue: `${node.key ?? node.label}${recording ? " (recording)" : ""}${this.store.sampledAt(node.sourceId) ? ` | Received ${new Date(this.store.sampledAt(node.sourceId)!).toISOString()}` : ""}` };
    }
    public async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) {
            const roots = this.store.roots.filter(n => n.children.length > 0);
            return roots.length ? roots.map(n => this.item(n)) : [{ id: "dummy-msg", label: "Waiting for structured JSON data over RTT or UART. Print one JSON object per line, or name={...}.", readonly: true }];
        }
        return (this.store.nodes.get(element.id)?.children ?? []).flatMap(id => { const n = this.store.nodes.get(id); return n ? [this.item(n)] : []; });
    }
    public async onCopyFirmwarePrompt(): Promise<void> {
        await vscode.env.clipboard.writeText(JSON_WATCH_FIRMWARE_PROMPT);
        void vscode.window.showInformationMessage("JSON firmware prompt copied in English.");
    }
    public async onEditName(): Promise<void> { /* Telemetry is read-only. */ }
    public async onEditValue(): Promise<void> { /* Never write to the target. */ }
    public async onSetExpanded(item: TreeItem, expanded: boolean): Promise<void> { this.expanded.set(item.id, expanded); }
    public clear(): void {
        if (this.recording || this.recordingPending) { void vscode.window.showInformationMessage("Stop JSON recording before clearing its samples."); return; }
        this.store.clear(); this.expanded.clear(); this.dirty.clear(); this.schemaDirty = true; this.schedule();
    }
    private async pick(action: string): Promise<WatchNode[]> {
        const leaves = this.store.leaves;
        if (!leaves.length) { void vscode.window.showInformationMessage("No JSON variables available. Enable an RTT channel or UART port and print a JSON record first."); return []; }
        const result = await vscode.window.showQuickPick(leaves.map(node => ({ label: `${node.watch}${node.path.map(p => `[${JSON.stringify(p)}]`).join("")}`,
            description: `${this.store.source(node.sourceId)?.sessionName} / ${watchSourceLabel(this.store.source(node.sourceId)!)}`,
            detail: node.key, picked: true, node })), { canPickMany: true, title: `JSON Live Watch: ${action}`, placeHolder: "Select fields; collapsed object and array children are included", matchOnDescription: true, matchOnDetail: true });
        return result?.map(item => item.node) ?? [];
    }
    public async saveSnapshot(): Promise<void> {
        const fields = await this.pick("Save Snapshot"); if (!fields.length || this.disposed) return;
        const uri = await vscode.window.showSaveDialog({ title: "Save JSON Live Watch Snapshot", saveLabel: "Save Snapshot", filters: { JSON: ["json"] } });
        if (!uri || this.disposed) return;
        const sampledAt = Date.now(), sources = [...new Set(fields.map(f => f.sourceId))].map(id => ({ ...this.store.source(id), sampledAt: this.store.sampledAt(id), connected: this.store.isActive(id) }));
        const values = Object.fromEntries(fields.map(f => [f.key!, this.store.nodes.get(f.id)?.scalar ?? null]));
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ format: "mcu-ai-debug.json-watch.v1", timestamp: sampledAt, sources, values }, null, 2) + "\n"));
            void vscode.window.showInformationMessage("JSON Live Watch snapshot saved as JSON.");
        } catch (error) { void vscode.window.showErrorMessage(`Could not save JSON snapshot: ${error}`); }
    }
    public async startRecording(): Promise<void> {
        if (this.recording || this.recordingPending || this.disposed) return;
        this.recordingPending = true;
        try {
            const fields = (await this.pick("Start Recording")).filter(f => this.store.isActive(f.sourceId));
            if (!fields.length || this.disposed) return;
            const uri = await vscode.window.showSaveDialog({ title: "Record JSON Live Watch Data", saveLabel: "Record", filters: { "JSON Lines": ["jsonl"], CSV: ["csv"] } });
            if (!uri || this.disposed || !fields.every(f => this.store.isActive(f.sourceId))) return;
            this.recordingFields = fields;
            const recording = await RttWatchRecording.create(uri.fsPath, uri.fsPath.toLowerCase().endsWith(".csv") ? "csv" : "jsonl", fields, error => {
                this.recording = undefined; this.recordingFields = []; void vscode.commands.executeCommand("setContext", "mcu-ai-debug:isRttWatchRecording", false);
                void vscode.window.showErrorMessage(`JSON Live Watch recording failed: ${error.message}`);
            });
            if (this.disposed || !fields.every(f => this.store.isActive(f.sourceId))) { await recording.stop(); return; }
            this.recording = recording;
            await vscode.commands.executeCommand("setContext", "mcu-ai-debug:isRttWatchRecording", true);
            this.tree.refresh();
        } catch (error) { this.recordingFields = []; void vscode.window.showErrorMessage(`Could not start JSON recording: ${error}`); }
        finally { this.recordingPending = false; }
    }
    public async stopRecording(): Promise<void> {
        const recording = this.recording; this.recording = undefined; this.recordingFields = [];
        await vscode.commands.executeCommand("setContext", "mcu-ai-debug:isRttWatchRecording", false);
        if (!recording) return;
        try { await recording.stop(); if (!this.disposed) void vscode.window.showInformationMessage("JSON Live Watch recording stopped and saved."); }
        catch (error) { if (!this.disposed) void vscode.window.showErrorMessage(`JSON recording could not finish: ${error}`); }
        this.tree.refresh();
    }
    private graphLabel(key: string): string {
        const node = this.store.leaves.find(n => n.key === key);
        if (!node) return key;
        const source = this.store.source(node.sourceId);
        return `${source?.sessionName} [${source?.sessionId.slice(0, 8)}] / ${source ? watchSourceLabel(source) : "JSON"} / ${node.watch}${node.path.map(p => `[${JSON.stringify(p)}]`).join("")}`;
    }
    public async openGraph(): Promise<void> {
        await this.grapher.openGraph(() => this.store.leaves.filter(n => typeof n.scalar === "number" || typeof n.scalar === "boolean").map(n => n.key!));
    }
    public dispose(): void {
        this.disposed = true; if (this.timer) clearTimeout(this.timer);
        sessionTelemetry.off("data", this.receive); sessionTelemetry.off("end", this.finishSession); sessionTelemetry.off("source-end", this.finishSource); this.subscriptions.forEach(s => s.dispose());
        this.grapher.dispose(); void this.stopRecording(); this.store.clear();
    }
}
