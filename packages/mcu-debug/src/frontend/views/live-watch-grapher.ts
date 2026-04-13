import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getNonce } from "../../adapter/servers/common";

/**
 * Live Watch real-time waveform graph manager.
 * Manages a WebviewPanel, receives variable updates from LiveWatchTreeProvider
 * and pushes them to the frontend Canvas 2D renderer.
 */
export class LiveWatchGrapher {
    private panel: vscode.WebviewPanel | undefined;
    private graphKeys: string[] = [];
    private ready = false;
    private pendingMessages: any[] = [];

    constructor(private extensionPath: string) {}

    /**
     * Open the graph panel. Shows a QuickPick for variable selection,
     * preserving previously selected variables as pre-checked.
     */
    public async openGraph(gatherLeafExprs: () => string[]) {
        const items = gatherLeafExprs();
        if (items.length === 0) {
            vscode.window.showInformationMessage("No valid variables to plot. Add variables to Live Watch and expand structs first.");
            return;
        }

        // Build QuickPick items with previous selections pre-checked
        const previousKeys = new Set(this.graphKeys);
        const pickItems: vscode.QuickPickItem[] = items.map(expr => ({
            label: expr,
            picked: previousKeys.has(expr),
        }));

        const selected = await vscode.window.showQuickPick(pickItems, {
            canPickMany: true,
            placeHolder: "Select variables to plot in real-time...",
        });

        if (!selected || selected.length === 0) {
            return;
        }

        this.graphKeys = selected.map(s => s.label);
        this.pendingMessages = [];

        if (this.panel) {
            // Panel already exists: just reconfigure
            this.panel.reveal(vscode.ViewColumn.Beside);
            if (this.ready) {
                this.sendConfigure();
            }
            // If not ready yet, sendConfigure will be called when 'ready' message arrives
        } else {
            this.ready = false;
            this.createPanel();
        }
    }

    /**
     * Push data to the graph. Called by LiveWatchTreeProvider.receivedVariableUpdates.
     */
    public pushData(timestamp: number, dataMap: { [key: string]: string }) {
        if (!this.panel || this.graphKeys.length === 0) {
            return;
        }

        const values: { [key: string]: string } = {};
        let hasAny = false;
        for (const key of this.graphKeys) {
            if (dataMap[key] !== undefined) {
                values[key] = this.sanitizeValue(dataMap[key]);
                hasAny = true;
            }
        }
        if (!hasAny) return;

        const msg = { type: "data", timestamp, values };
        if (this.ready) {
            this.panel.webview.postMessage(msg);
        } else {
            this.pendingMessages.push(msg);
        }
    }

    public get isOpen(): boolean {
        return this.panel !== undefined;
    }

    public getGraphKeys(): string[] {
        return this.graphKeys;
    }

    private createPanel() {
        const showOptions = {
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Beside,
        };
        const viewOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
            retainContextWhenHidden: true,
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, "resources"))],
        };

        this.panel = vscode.window.createWebviewPanel(
            "mcu-debug.liveWatchGraph",
            "Live Watch Graph",
            showOptions,
            viewOptions,
        );

        this.panel.webview.html = this.getHTML();

        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.type === "ready") {
                this.ready = true;
                this.sendConfigure();
                for (const m of this.pendingMessages) {
                    this.panel!.webview.postMessage(m);
                }
                this.pendingMessages = [];
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.graphKeys = [];
            this.ready = false;
            this.pendingMessages = [];
        });
    }

    private sendConfigure() {
        if (this.panel && this.ready) {
            this.panel.webview.postMessage({
                type: "configure",
                keys: this.graphKeys,
            });
        }
    }

    private getHTML(): string {
        const nonce = getNonce();
        const scriptUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.file(path.join(this.extensionPath, "resources", "live-watch-graph.js")),
        );

        let html = fs.readFileSync(
            path.join(this.extensionPath, "resources", "live-watch-graph.html"),
            { encoding: "utf8", flag: "r" },
        );
        html = html
            .replace(/\$\{nonce\}/g, nonce)
            .replace(/\$\{scriptUri\}/g, scriptUri.toString());

        return html;
    }

    private sanitizeValue(raw: string): string {
        if (!raw) return "";
        const charMatch = raw.match(/^(-?\d+)\s+'.*'$/);
        if (charMatch) return charMatch[1];
        const enumMatch = raw.match(/^.*=\s*(-?\d+)$/);
        if (enumMatch) return enumMatch[1];
        return raw;
    }
}
