import * as net from "net";
import * as vscode from "vscode";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LiveWatchTreeProvider } from "./views/live-watch";

/**
 * MCP Server that exposes Live Watch data via TCP socket.
 * Uses StdioServerTransport over the socket's read/write streams.
 */
export class LiveWatchMcpServer {
    private server: net.Server;
    private readonly port = 51234;
    private mcpServer: Server | null = null;
    private liveWatchProvider: LiveWatchTreeProvider;

    constructor(liveWatchProvider: LiveWatchTreeProvider) {
        this.liveWatchProvider = liveWatchProvider;

        this.mcpServer = new Server({
            name: "mcu-debug",
            version: "0.1.1"
        }, {
            capabilities: {
                tools: {}
            }
        });

        this.setupTools();

        this.server = net.createServer((socket) => {
            console.log("MCP Client connected to MCU-Debug on TCP port", this.port);

            const transport = new StdioServerTransport(socket, socket);
            
            this.mcpServer!.connect(transport).catch(e => {
                console.error("MCP Server connection error:", e);
                socket.destroy();
            });

            socket.on("error", (err) => {
                console.error("MCP Socket error:", err);
            });
            
            socket.on("close", () => {
                console.log("MCP Client disconnected from MCU-Debug");
                transport.close();
            });
        });
    }

    /**
     * Check if there is an active debug session.
     */
    private isDebugActive(): boolean {
        return LiveWatchTreeProvider.session !== undefined;
    }

    /**
     * Register all MCP tools for external AI agent consumption.
     */
    private setupTools() {
        if (!this.mcpServer) return;

        this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "get_livewatch_variables",
                        description: "Get the current snapshot of all variables in the MCU-Debug Live Watch panel.",
                        inputSchema: { type: "object", properties: {}, required: [] }
                    },
                    {
                        name: "add_livewatch_variable",
                        description: "Add a C/C++ expression to the Live Watch panel for real-time monitoring.",
                        inputSchema: {
                            type: "object",
                            properties: { expr: { type: "string", description: "A valid C/C++ expression (e.g. 'g_motor.speed', 'adc_buffer[0]')." } },
                            required: ["expr"]
                        }
                    },
                    {
                        name: "expand_livewatch_struct",
                        description: "Expand an unexpanded struct/array in the Live Watch panel to reveal its children.",
                        inputSchema: {
                            type: "object",
                            properties: { expr: { type: "string", description: "The exact expression of the struct/array to expand." } },
                            required: ["expr"]
                        }
                    },
                    {
                        name: "record_livewatch_variables",
                        description: "Automatically record Live Watch values for a fixed duration. Returns timeseries data.",
                        inputSchema: {
                            type: "object",
                            properties: { duration_ms: { type: "number", description: "Duration to record in milliseconds (e.g. 5000 for 5 seconds)." } },
                            required: ["duration_ms"]
                        }
                    },
                    {
                        name: "record_livewatch_variables_manual",
                        description: "Record Live Watch values with manual user-controlled start/stop. No duration needed. The user clicks Start and Stop in VS Code.",
                        inputSchema: { type: "object", properties: {}, required: [] }
                    }
                ]
            };
        });

        this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case "get_livewatch_variables": {
                    if (!this.isDebugActive()) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_DEBUG_SESSION" }, null, 2) }], isError: true };
                    }
                    try {
                        const result: { [key: string]: string } = {};
                        for (const node of this.liveWatchProvider.gdbVarNameToNodeMap.values()) {
                            const curExpr = node.getExpr();
                            if (!curExpr || node.isDummyNode()) continue;

                            const actualChildren = node.getChildren();
                            const hasLoadedChildren = actualChildren && actualChildren.length > 0 && actualChildren[0].getName() !== "dummy";
                            const isCompound = node.variablesReference > 0 || hasLoadedChildren;

                            if (isCompound && !hasLoadedChildren) {
                                result[curExpr] = "<STRUCT_OR_ARRAY_UNEXPANDED>";
                            } else if (!isCompound) {
                                result[curExpr] = node.getDisplayValue();
                            }
                        }
                        if (Object.keys(result).length === 0) {
                            return { content: [{ type: "text", text: JSON.stringify({ status: "NO_VARIABLES" }, null, 2) }] };
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ status: "OK", variables: result }, null, 2) }] };
                    } catch (err: any) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: err.message }, null, 2) }], isError: true };
                    }
                }

                case "expand_livewatch_struct": {
                    if (!this.isDebugActive()) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_DEBUG_SESSION" }, null, 2) }], isError: true };
                    }
                    const exprExpand = String(request.params.arguments?.expr);
                    if (!exprExpand) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Missing required argument 'expr'." }, null, 2) }], isError: true };
                    }
                    let targetNode;
                    for (const node of this.liveWatchProvider.gdbVarNameToNodeMap.values()) {
                        if (node.getExpr() === exprExpand && !node.isDummyNode()) {
                            targetNode = node;
                            break;
                        }
                    }
                    if (!targetNode) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_FOUND", error: `No variable matching '${exprExpand}' found in Live Watch.` }, null, 2) }], isError: true };
                    }
                    if (targetNode.variablesReference === 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NOT_EXPANDABLE", error: `'${exprExpand}' is a leaf variable, not a struct/array.` }, null, 2) }], isError: true };
                    }
                    try {
                        await targetNode.expandChildren();
                        return { content: [{ type: "text", text: JSON.stringify({ status: "OK", message: `Expanded '${exprExpand}'. Call get_livewatch_variables to see its children.` }, null, 2) }] };
                    } catch (err: any) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: err.message }, null, 2) }], isError: true };
                    }
                }

                case "record_livewatch_variables": {
                    if (!this.isDebugActive()) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_DEBUG_SESSION" }, null, 2) }], isError: true };
                    }
                    // If the user has enabled manual recording mode, reject automatic recording
                    // and instruct the agent to use the manual recording tool instead.
                    const configAuto = vscode.workspace.getConfiguration("mcu-debug", null);
                    if (configAuto.get<boolean>("mcpRequireManualRecording", false)) {
                        return { content: [{ type: "text", text: JSON.stringify({
                            status: "MANUAL_MODE_REQUIRED",
                            error: "The user has enabled manual recording mode. Use the 'record_livewatch_variables_manual' tool instead. It requires no input parameters — the user will click Start and Stop in VS Code."
                        }, null, 2) }], isError: true };
                    }

                    const maxAutoMs = configAuto.get<number>("mcpRecordingMaxDuration", 30) * 1000;
                    let durationMs = Number(request.params.arguments?.duration_ms);
                    if (isNaN(durationMs) || durationMs <= 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Invalid or missing 'duration_ms'. Must be a positive number." }, null, 2) }], isError: true };
                    }
                    durationMs = Math.min(durationMs, maxAutoMs);

                    // Check whether there are any recordable leaf variables
                    const leafExprsAuto = this.liveWatchProvider.gatherLeafExprs();
                    if (leafExprsAuto.length === 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_VARIABLES" }, null, 2) }] };
                    }

                    const dataAuto: any[] = [];
                    const listenerAuto = (time: number, values: { [key: string]: string }) => {
                        dataAuto.push({ time, values: { ...values } });
                    };

                    this.liveWatchProvider.mcpListeners.push(listenerAuto);
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `AI recording Live Watch data (${durationMs / 1000}s)...`,
                        cancellable: true
                    }, async (_progress, token) => {
                        return new Promise<void>(resolve => {
                            const timeout = setTimeout(resolve, durationMs);
                            token.onCancellationRequested(() => {
                                clearTimeout(timeout);
                                resolve();
                            });
                        });
                    });
                    this.liveWatchProvider.mcpListeners = this.liveWatchProvider.mcpListeners.filter(l => l !== listenerAuto);

                    if (dataAuto.length === 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "CANCELLED_OR_EMPTY", records: [] }, null, 2) }] };
                    }
                    return { content: [{ type: "text", text: JSON.stringify({ status: "OK", duration_ms: durationMs, sample_count: dataAuto.length, records: dataAuto }, null, 2) }] };
                }

                case "record_livewatch_variables_manual": {
                    if (!this.isDebugActive()) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_DEBUG_SESSION" }, null, 2) }], isError: true };
                    }

                    // Check whether there are any recordable leaf variables
                    const leafExprsManual = this.liveWatchProvider.gatherLeafExprs();
                    if (leafExprsManual.length === 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_VARIABLES" }, null, 2) }] };
                    }

                    const configManual = vscode.workspace.getConfiguration("mcu-debug", null);
                    const maxManualMs = configManual.get<number>("mcpManualRecordingMaxDuration", 60) * 1000;

                    // Phase 1: prompt the user to confirm the start of recording
                    const startAns = await vscode.window.showInformationMessage(
                        "AI Agent is requesting to record Live Watch data. Click Start when you are ready.",
                        "Start", "Cancel"
                    );
                    if (startAns !== "Start") {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "CANCELLED_BY_USER", error: "The user declined or dismissed the recording prompt." }, null, 2) }], isError: true };
                    }

                    // Phase 2: start recording and wait for the user to click Stop or for a timeout
                    const dataManual: any[] = [];
                    const listenerManual = (time: number, values: { [key: string]: string }) => {
                        dataManual.push({ time, values: { ...values } });
                    };

                    this.liveWatchProvider.mcpListeners.push(listenerManual);
                    const stopResult: string = await new Promise(resolve => {
                        const timeout = setTimeout(() => resolve("timeout"), maxManualMs);
                        vscode.window.showInformationMessage(
                            `Recording Live Watch data... (max ${maxManualMs / 1000}s)`,
                            "Stop Recording"
                        ).then(ans => {
                            clearTimeout(timeout);
                            resolve(ans === "Stop Recording" ? "stopped" : "dismissed");
                        });
                    });
                    this.liveWatchProvider.mcpListeners = this.liveWatchProvider.mcpListeners.filter(l => l !== listenerManual);

                    const endReason = stopResult === "timeout" ? "MAX_DURATION_REACHED" : "USER_STOPPED";
                    if (dataManual.length === 0) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "CANCELLED_OR_EMPTY", end_reason: endReason, records: [] }, null, 2) }] };
                    }
                    return { content: [{ type: "text", text: JSON.stringify({ status: "OK", end_reason: endReason, sample_count: dataManual.length, records: dataManual }, null, 2) }] };
                }

                case "add_livewatch_variable": {
                    if (!this.isDebugActive()) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "NO_DEBUG_SESSION" }, null, 2) }], isError: true };
                    }
                    const exprAdd = String(request.params.arguments?.expr);
                    if (!exprAdd) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: "Missing required argument 'expr'." }, null, 2) }], isError: true };
                    }
                    try {
                        this.liveWatchProvider.addWatchExpr(exprAdd);
                        return { content: [{ type: "text", text: JSON.stringify({ status: "OK", expression: exprAdd }, null, 2) }] };
                    } catch (err: any) {
                        return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: err.message }, null, 2) }], isError: true };
                    }
                }

                default:
                    return { content: [{ type: "text", text: JSON.stringify({ status: "UNKNOWN_TOOL", error: `No tool named '${request.params.name}'.` }, null, 2) }], isError: true };
            }
        });
    }

    public start() {
        this.server.listen(this.port, "127.0.0.1", () => {
            console.log(`MCU-Debug-AI MCP Server listening on 127.0.0.1:${this.port}`);
        });

        this.server.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "EADDRINUSE") {
                console.warn(`Port ${this.port} is already in use. Assuming MCP Server is handled by another window.`);
            } else {
                console.error("MCP Server Error:", e);
            }
        });
    }

    public dispose() {
        if (this.server) {
            this.server.close();
        }
        if (this.mcpServer) {
            this.mcpServer.close();
        }
    }
}
