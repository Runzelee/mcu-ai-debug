import * as vscode from "vscode";

export interface TreeItem {
    id: string;
    label: string;
    actualValue?: string;
    value?: string;
    format?: string;
    hasChildren?: boolean;
    expanded?: boolean;
    contextValue?: string;
    changed?: boolean;
    readonly?: boolean;
}

export interface TreeViewProviderDelegate {
    getChildren(element?: TreeItem): Promise<TreeItem[]>;
    onEditName(item: TreeItem, newValue: string): Promise<void>;
    onEditValue(item: TreeItem, newValue: string): Promise<void>;
    onDelete?(item: TreeItem): Promise<void>;
    onAdd?(value: string): Promise<void>;
    onAddMany?(value: string): Promise<BatchOperationResult>;
    onDeleteMany?(items: TreeItem[]): Promise<BatchOperationResult>;
    onMoveUp?(item: TreeItem): Promise<void>;
    onMoveDown?(item: TreeItem): Promise<void>;
    onSetFormat?(item: TreeItem, format: string): Promise<void>;
    onCopyFirmwarePrompt?(): Promise<void>;
    onSetExpanded?(item: TreeItem, expanded: boolean): Promise<void>;
}

export interface BatchOperationResult {
    changed: number;
    skipped: number;
    message: string;
}

export class EditableTreeViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private batchMode = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _delegate: TreeViewProviderDelegate,
        private readonly options: { readOnly?: boolean; copyFirmwarePrompt?: boolean } = {},
    ) {}

    public async add() {
        const value = await vscode.window.showInputBox({
            prompt: "Add new expression to Live Watch",
            placeHolder: "Expression"
        });
        if (value && this._delegate.onAdd) {
            await this._delegate.onAdd(value);
            this.refresh();
        }
    }

    public toggleBatchMode() {
        this.batchMode = !this.batchMode;
        this._view?.webview.postMessage({ type: "setBatchMode", enabled: this.batchMode });
    }

    public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (this.options.readOnly && !["getChildren", "setExpanded", "copyFirmwarePrompt"].includes(data.type)) return;
            switch (data.type) {
                case "copyFirmwarePrompt":
                    if (this.options.copyFirmwarePrompt) await this._delegate.onCopyFirmwarePrompt?.();
                    break;
                case "getChildren":
                    const children = await this._delegate.getChildren(data.element);
                    this._view?.webview.postMessage({ type: "setChildren", element: data.element, children });
                    break;
                case "beginEdit":
                    const fieldName = data.field === "label" ? "Expression" : "Value";
                    const newValue = await vscode.window.showInputBox({
                        prompt: `Edit ${fieldName}`,
                        value: data.value
                    });
                    if (newValue !== undefined) {
                        if (data.field === "label") {
                            await this._delegate.onEditName(data.item, newValue);
                        } else {
                            await this._delegate.onEditValue(data.item, newValue);
                        }
                        this.refresh();
                    }
                    break;
                case "edit":
                    if (data.field && data.field === "label") {
                        await this._delegate.onEditName(data.item, data.value);
                    } else {
                        await this._delegate.onEditValue(data.item, data.value);
                    }
                    this.refresh();
                    break;
                case "add":
                    if (this._delegate.onAdd) {
                        await this._delegate.onAdd(data.value);
                        this.refresh();
                    }
                    break;
                case "addRequested":
                    await this.add();
                    break;
                case "addMany":
                    if (this._delegate.onAddMany) {
                        const result = await this._delegate.onAddMany(data.value);
                        this._view?.webview.postMessage({ type: "batchResult", operation: "add", result });
                        this.refresh();
                    }
                    break;
                case "delete":
                    if (this._delegate.onDelete) {
                        await this._delegate.onDelete(data.item);
                        this.refresh();
                    }
                    break;
                case "deleteMany":
                    if (this._delegate.onDeleteMany && Array.isArray(data.items) && data.items.length > 0) {
                        const confirmation = await vscode.window.showWarningMessage(
                            `Remove ${data.items.length} selected Live Watch expression${data.items.length === 1 ? "" : "s"}?`,
                            { modal: true },
                            "Remove",
                        );
                        if (confirmation === "Remove") {
                            const result = await this._delegate.onDeleteMany(data.items);
                            this._view?.webview.postMessage({ type: "batchResult", operation: "delete", result });
                            this.refresh();
                        } else {
                            this._view?.webview.postMessage({ type: "batchCancelled" });
                        }
                    }
                    break;
                case "batchModeChanged":
                    this.batchMode = Boolean(data.enabled);
                    break;
                case "moveUp":
                    if (this._delegate.onMoveUp) {
                        await this._delegate.onMoveUp(data.item);
                        this.refresh();
                    }
                    break;
                case "moveDown":
                    if (this._delegate.onMoveDown) {
                        await this._delegate.onMoveDown(data.item);
                        this.refresh();
                    }
                    break;
                case "setFormat":
                    if (this._delegate.onSetFormat) {
                        await this._delegate.onSetFormat(data.item, data.format);
                        this.refresh();
                    }
                    break;
                case "setExpanded":
                    if (this._delegate.onSetExpanded) {
                        await this._delegate.onSetExpanded(data.item, data.expanded);
                    }
                    break;
            }
        });
    }

    public refresh() {
        if (this._view) {
            this._view.webview.postMessage({ type: "refresh" });
        }
    }

    public updateComposite(items: TreeItem[]) {
        if (this._view) {
            this._view.webview.postMessage({ type: "updateItems", items });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "webview-tree.css"));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "resources", "codicons", "codicon.css"));

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
            <link href="${styleUri}" rel="stylesheet" />
            <link href="${codiconsUri}" rel="stylesheet" />
        </head>
        <body data-readonly="${Boolean(this.options.readOnly)}" data-copy-firmware-prompt="${Boolean(this.options.copyFirmwarePrompt)}">
            <section id="batch-toolbar" class="batch-toolbar" hidden>
                <label for="batch-input">Paste expressions (one per line), then choose which to add</label>
                <textarea id="batch-input" rows="4" placeholder="motor.speed&#10;sensors[index].value"></textarea>
                <div id="batch-add-list" class="batch-add-list" aria-label="Expressions to add"></div>
                <div class="batch-actions">
                    <button id="batch-add" type="button" disabled>Add selected</button>
                    <button id="batch-select-all" type="button">Select all watches</button>
                    <button id="batch-delete" type="button" disabled>Remove selected</button>
                    <button id="batch-done" type="button">Done</button>
                </div>
                <div id="batch-status" class="batch-status" role="status" aria-live="polite"></div>
            </section>
            <div id="tree-root"></div>
            <script src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}
