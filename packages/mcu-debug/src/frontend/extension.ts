// Copyright (c) 2026 MCU-Debug Authors.
// This source code is licensed under the MIT license found in the
// LICENSE-MIT file in the root directory of this source tree.

import * as vscode from "vscode";
import * as path from "path";

import { MCUDebugChannel } from "../dbgmsgs";
import { LiveWatchTreeProvider, LiveVariableNode } from "./views/live-watch";
import { LiveWatchGrapher } from "./views/live-watch-grapher";
import { LiveWatchMcpServer } from "./mcp-server";
import { EditableTreeViewProvider } from "./webview_tree/editable-tree";

import { RTTCore, SWOCore } from "./swo/core";
import { ConfigurationArguments, RTTCommonDecoderOpts, RTTConsoleDecoderOpts, MCUDebugKeys, ChainedEvents, ChainedConfig } from "../adapter/servers/common";
import { Reporting } from "../analytics/reporting";

import { CortexDebugConfigurationProvider } from "./configprovider";
import { JLinkSocketRTTSource, SocketRTTSource, SocketSWOSource, PeMicroSocketSource } from "./swo/sources/socket";
import { FifoSWOSource } from "./swo/sources/fifo";
import { FileSWOSource } from "./swo/sources/file";
import { SerialSWOSource } from "./swo/sources/serial";
import { UsbSWOSource } from "./swo/sources/usb";
import { SymbolInformation, SymbolScope } from "../adapter/symbols";
import { RTTTerminal } from "./rtt_terminal";
import { GDBServerConsole } from "./server_console";
import { CDebugSession, CDebugChainedSessionItem } from "./cortex_debug_session";
import { ServerConsoleLog } from "../adapter/server-console-log";
import { isVarRefGlobalOrStatic } from "../adapter/var-scopes";

interface SVDInfo {
    expression: RegExp;
    path: string;
}
class ServerStartedPromise {
    constructor(
        public readonly name: string,
        public readonly promise: Promise<vscode.DebugSessionCustomEvent>,
        public readonly resolve: any,
        public readonly reject: any,
    ) {}
}

export class MCUDebugExtension {
    private rttTerminals: RTTTerminal[] = [];

    private gdbServerConsole: GDBServerConsole | null = null;

    private liveWatchProvider!: LiveWatchTreeProvider;
    private liveWatchWebview!: EditableTreeViewProvider;
    private liveWatchGrapher!: LiveWatchGrapher;
    private liveWatchMcpServer!: LiveWatchMcpServer;

    private SVDDirectory: SVDInfo[] = [];
    private functionSymbols: SymbolInformation[] = [];
    private serverStartedEvent: ServerStartedPromise | null = null;

    constructor(private context: vscode.ExtensionContext) {}

    public async initialize() {
        const context: vscode.ExtensionContext = this.context;
        const config = vscode.workspace.getConfiguration("mcu-debug");
        await this.startServerConsole(context, config.get(MCUDebugKeys.SERVER_LOG_FILE_NAME, "")); // Make this the first thing we do to be ready for the session

        this.liveWatchProvider = new LiveWatchTreeProvider(this.context);
        this.liveWatchWebview = new EditableTreeViewProvider(this.context.extensionUri, this.liveWatchProvider);
        this.liveWatchGrapher = new LiveWatchGrapher(this.context.extensionPath);
        this.liveWatchMcpServer = new LiveWatchMcpServer(this.liveWatchProvider);
        
        this.liveWatchProvider.setRefreshCallback(() => this.liveWatchWebview.refresh());
        this.liveWatchProvider.setUpdateItemsCallback((items) => this.liveWatchWebview.updateComposite(items));
        this.liveWatchProvider.setGrapher(this.liveWatchGrapher);
        
        this.liveWatchMcpServer.start();
        context.subscriptions.push({ dispose: () => this.liveWatchMcpServer.dispose() });

        context.subscriptions.push(vscode.window.registerWebviewViewProvider("mcu-debug.liveWatch", this.liveWatchWebview));

        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.VARIABLE_DISPLAY_MODE}`, config.get(MCUDebugKeys.VARIABLE_DISPLAY_MODE, true));

        context.subscriptions.push(
            vscode.commands.registerCommand("mcu-debug.varHexModeTurnOn", this.variablesNaturalMode.bind(this, false)),
            vscode.commands.registerCommand("mcu-debug.varHexModeTurnOff", this.variablesNaturalMode.bind(this, true)),
            vscode.commands.registerCommand("mcu-debug.toggleVariableHexFormat", this.toggleVariablesHexMode.bind(this)),

            vscode.commands.registerCommand("mcu-debug.examineMemory", this.examineMemory.bind(this)),

            vscode.commands.registerCommand("mcu-debug.resetDevice", this.resetDevice.bind(this)),

            vscode.commands.registerCommand("mcu-debug.liveWatch.addExpr", this.addLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.removeExpr", this.removeLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.editExpr", this.editLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.addToLiveWatch", this.addToLiveWatch.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.moveUp", this.moveUpLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.moveDown", this.moveDownLiveWatchExpr.bind(this)),

            vscode.commands.registerCommand("mcu-debug-ai.liveWatch.addSelectionToLiveWatch", this.addSelectionToLiveWatch.bind(this)),
            vscode.commands.registerCommand("mcu-debug-ai.liveWatch.startRecording", this.startLiveWatchRecording.bind(this)),
            vscode.commands.registerCommand("mcu-debug-ai.liveWatch.stopRecording", this.stopLiveWatchRecording.bind(this)),
            vscode.commands.registerCommand("mcu-debug-ai.liveWatch.openGraph", this.openLiveWatchGraph.bind(this)),
            vscode.commands.registerCommand("mcu-debug-ai.generateMcpConfig", this.generateMcpConfig.bind(this)),

            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent(this.receivedCustomEvent.bind(this)),
            vscode.debug.onDidStartDebugSession(this.debugSessionStarted.bind(this)),
            vscode.debug.onDidTerminateDebugSession(this.debugSessionTerminated.bind(this)),
            vscode.window.onDidCloseTerminal(this.terminalClosed.bind(this)),

            vscode.debug.registerDebugConfigurationProvider("mcu-debug", new CortexDebugConfigurationProvider(context)),
        );
    }

    public static getActiveCDSession() {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === "mcu-debug") {
            return session;
        }
        return null;
    }

    private resetDevice() {
        let session = MCUDebugExtension.getActiveCDSession();
        if (session) {
            let mySession = CDebugSession.FindSession(session);
            const parentConfig = mySession?.config?.pvtParent;
            while (mySession && parentConfig) {
                // We have a parent. See if our life-cycle is managed by our parent, if so
                // send a reset to the parent instead
                const chConfig = mySession.config?.pvtMyConfigFromParent as ChainedConfig;
                if (chConfig?.lifecycleManagedByParent && parentConfig.__sessionId) {
                    // __sessionId is not documented but has existed forever and used by VSCode itself
                    mySession = CDebugSession.FindSessionById(parentConfig.__sessionId);
                    if (!mySession) {
                        break;
                    }
                    session = mySession.session || session;
                } else {
                    break;
                }
            }
            session.customRequest("reset-device", "reset");
        }
    }

    private async startServerConsole(context: vscode.ExtensionContext, logFName: string = ""): Promise<void> {
        try {
            this.gdbServerConsole = new GDBServerConsole(context, logFName);
            await this.gdbServerConsole.startServer();
        } catch (e: any) {
            this.gdbServerConsole?.dispose();
            this.gdbServerConsole = null;
            vscode.window.showErrorMessage(`Could not create gdb-server-console. Extension startup failed. Please report this problem. ${e.toString()}`);
        }
    }

    private settingsChanged(e: vscode.ConfigurationChangeEvent) {
        if (e.affectsConfiguration(`mcu-debug.${MCUDebugKeys.VARIABLE_DISPLAY_MODE}`)) {
            const config = vscode.workspace.getConfiguration("mcu-debug");
            const isHex = config.get(MCUDebugKeys.VARIABLE_DISPLAY_MODE, true) ? false : true;
            let foundStopped = false;
            for (const s of CDebugSession.CurrentSessions) {
                try {
                    // Session may not have actually started according to VSCode but we know of it
                    if (this.isDebugging(s.session)) {
                        s.session.customRequest("set-var-format", { hex: isHex }).then(() => {
                            if (s.status === "stopped" && this.liveWatchProvider?.isSameSession(s.session)) {
                                this.liveWatchProvider?.refresh();
                            }
                        });
                        if (s.status === "stopped") {
                            foundStopped = true;
                        }
                    }
                } catch (e) {
                    console.error("set-var-format", e);
                }
            }
            if (!foundStopped) {
                const fmt = isHex ? "hex" : "dec";
                const msg = `mcu-debug: Variables window format "${fmt}" will take effect next time the session pauses`;
                vscode.window.showInformationMessage(msg);
            }
        }
        if (e.affectsConfiguration(`mcu-debug.${MCUDebugKeys.SERVER_LOG_FILE_NAME}`)) {
            const config = vscode.workspace.getConfiguration("mcu-debug");
            const fName = config.get(MCUDebugKeys.SERVER_LOG_FILE_NAME, "");
            this.gdbServerConsole?.createLogFile(fName);
        }
    }

    private getSVDFile(device: string): string {
        const entry = this.SVDDirectory.find((de) => de.expression.test(device));
        return entry ? entry.path : "";
    }

    public registerSVDFile(expression: RegExp | string, path: string): void {
        if (typeof expression === "string") {
            expression = new RegExp(`^${expression}$`, "");
        }

        this.SVDDirectory.push({ expression: expression, path: path });
    }

    private examineMemory() {
        const cmd = "mcu-debug.memory-view.addMemoryView";
        vscode.commands.executeCommand(cmd).then(
            () => {},
            (e) => {
                const installExt = "Install MemoryView Extension";
                vscode.window
                    .showErrorMessage(
                        `Unable to execute ${cmd}. Perhaps the MemoryView extension is not installed. ` + "Please install extension and try again. A restart may be needed",
                        {
                            title: installExt,
                        },
                        {
                            title: "Cancel",
                        },
                    )
                    .then((v) => {
                        if (v && v.title === installExt) {
                            vscode.commands.executeCommand("workbench.extensions.installExtension", "mcu-debug.memory-view");
                        }
                    });
            },
        );
    }

    private getConfigSource(config: vscode.WorkspaceConfiguration, section: string): [vscode.ConfigurationTarget, boolean] {
        const configurationTargetMapping: [string, vscode.ConfigurationTarget][] = [
            ["workspaceFolder", vscode.ConfigurationTarget.WorkspaceFolder],
            ["workspace", vscode.ConfigurationTarget.Workspace],
            ["global", vscode.ConfigurationTarget.Global],
            // Modify user settings if setting isn't configured yet
            ["default", vscode.ConfigurationTarget.Global],
        ];
        const info = config.inspect(section);
        for (const inspectKeySuffix of ["LanguageValue", "Value"]) {
            for (const mapping of configurationTargetMapping) {
                const [inspectKeyPrefix, mappingTarget] = mapping;
                const inspectKey = inspectKeyPrefix + inspectKeySuffix;
                if (info && (info as any)[inspectKey] !== undefined) return [mappingTarget, inspectKeySuffix == "LanguageValue"];
            }
        }
        // Shouldn't get here unless new configuration targets get added to the
        // VSCode API, only those sources have values for this setting, and this
        // setting doesn't have a default value. Still, do something rational
        // just in case.
        return [vscode.ConfigurationTarget.Global, false];
    }

    // Settings changes
    private variablesNaturalMode(newVal: boolean, cxt?: any) {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration("mcu-debug");

        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, MCUDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(MCUDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    private toggleVariablesHexMode() {
        // 'cxt' contains the treeItem on which this menu was invoked. Maybe we can do something
        // with it later
        const config = vscode.workspace.getConfiguration("mcu-debug");
        const curVal = config.get(MCUDebugKeys.VARIABLE_DISPLAY_MODE, true);
        const newVal = !curVal;
        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.VARIABLE_DISPLAY_MODE}`, newVal);
        try {
            const [target, languageOverride] = this.getConfigSource(config, MCUDebugKeys.VARIABLE_DISPLAY_MODE);
            config.update(MCUDebugKeys.VARIABLE_DISPLAY_MODE, newVal, target, languageOverride);
        } catch (e) {
            console.error(e);
        }
    }

    // Debug Events
    private debugSessionStarted(session: vscode.DebugSession) {
        if (session.type !== "mcu-debug") {
            return;
        }

        const newSession = CDebugSession.NewSessionStarted(session);

        this.functionSymbols = [];
        session.customRequest("get-arguments").then(
            (args) => {
                if (args.pvtRttConfig) {
                    args.rttConfig = args.pvtRttConfig;
                    delete args.pvtRttConfig;
                }
                newSession.config = args;
                let svdfile = args.svdFile;
                if (!svdfile) {
                    svdfile = this.getSVDFile(args.device);
                }

                Reporting.beginSession(session.id, args as ConfigurationArguments);

                if (newSession.swoSource) {
                    this.initializeSWO(session, args);
                }
                if (Object.keys(newSession.rttPortMap).length > 0) {
                    this.initializeRTT(session, args);
                }
                this.cleanupRTTTerminals();
            },
            (error) => {
                vscode.window.showErrorMessage(`Internal Error: Could not get startup arguments. Many debug functions can fail. Please report this problem. Error: ${error}`);
            },
        );
    }

    private debugSessionTerminated(session: vscode.DebugSession) {
        if (session.type !== "mcu-debug") {
            return;
        }
        const mySession = CDebugSession.FindSession(session);
        try {
            Reporting.endSession(session.id);

            this.liveWatchProvider?.debugSessionTerminated(session);
            if (mySession?.swo) {
                mySession.swo.debugSessionTerminated();
            }
            if (mySession?.swoSource) {
                mySession.swoSource.dispose();
            }
            if (mySession?.rtt) {
                mySession.rtt.debugSessionTerminated();
            }
            if (mySession?.rttPortMap) {
                for (const ch of Object.keys(mySession.rttPortMap)) {
                    mySession.rttPortMap[Number(ch)].dispose();
                }
                mySession.rttPortMap = {};
            }
        } catch (e: any) {
            vscode.window.showInformationMessage(`Debug session did not terminate cleanly ${e}\n${e ? e.stackstrace : ""}. Please report this problem`);
        } finally {
            CDebugSession.RemoveSession(session);
        }
    }

    private receivedCustomEvent(e: vscode.DebugSessionCustomEvent) {
        const session = e.session;
        if (session.type !== "mcu-debug") {
            return;
        }
        switch (e.event) {
            case "custom-stop":
                this.receivedStopEvent(e);
                break;
            case "custom-continued":
                this.receivedContinuedEvent(e);
                break;
            case "swo-configure":
                this.receivedSWOConfigureEvent(e);
                break;
            case "rtt-configure":
                this.receivedRTTConfigureEvent(e);
                break;
            case "record-event":
                this.receivedEvent(e);
                break;
            case "custom-event-post-start-server":
                this.startChainedConfigs(e, ChainedEvents.POSTSTART);
                break;
            case "custom-event-post-start-gdb":
                this.startChainedConfigs(e, ChainedEvents.POSTINIT);
                this.liveWatchProvider?.debugSessionStarted(session);
                break;
            case "custom-event-session-terminating":
                ServerConsoleLog(`Got event for sessions terminating PID=${process.pid}`);
                this.endChainedConfigs(e);
                break;
            case "custom-event-session-reset":
                this.resetOrResartChained(e, "reset");
                break;
            case "custom-event-popup": {
                const msg = e.body.info?.message;
                switch (e.body.info?.type) {
                    case "warning":
                        vscode.window.showWarningMessage(msg);
                        break;
                    case "error":
                        vscode.window.showErrorMessage(msg);
                        break;
                    default:
                        vscode.window.showInformationMessage(msg);
                        break;
                }
                break;
            }
            case "custom-event-ports-allocated":
                this.registerPortsAsUsed(e);
                break;
            case "custom-event-ports-done":
                this.signalPortsAllocated(e);
                break;
            case "custom-live-watch-updates":
                this.liveWatchProvider?.receivedVariableUpdates(e);
                break;
            case "custom-live-watch-connected":
                this.liveWatchProvider?.liveWatchConnected(e);
                break;
            default:
                break;
        }
    }

    private signalPortsAllocated(e: vscode.DebugSessionCustomEvent) {
        if (this.serverStartedEvent) {
            this.serverStartedEvent.resolve(e);
            this.serverStartedEvent = null;
        }
    }

    private registerPortsAsUsed(e: vscode.DebugSessionCustomEvent) {
        // We can get this event before the session starts
        const mySession = CDebugSession.GetSession(e.session);
        mySession.addUsedPorts(e.body?.info || []);
    }

    private async startChainedConfigs(e: vscode.DebugSessionCustomEvent, evType: ChainedEvents) {
        const adapterArgs = e?.body?.info as ConfigurationArguments;
        const cDbgParent = CDebugSession.GetSession(e.session, adapterArgs);
        if (!adapterArgs || !adapterArgs.chainedConfigurations?.enabled) {
            return;
        }
        const unique = adapterArgs.chainedConfigurations.launches.filter((x, ix) => {
            return ix === adapterArgs.chainedConfigurations.launches.findIndex((v, ix) => v.name === x.name);
        });
        const filtered = unique.filter((launch) => {
            return launch.enabled && launch.waitOnEvent === evType && launch.name;
        });

        let delay = 0;
        let count = filtered.length;
        for (const launch of filtered) {
            count--;
            const childOptions: vscode.DebugSessionOptions = {
                consoleMode: vscode.DebugConsoleMode.Separate,
                noDebug: adapterArgs.noDebug,
                compact: false,
            };
            if (launch.lifecycleManagedByParent) {
                // VSCode 'lifecycleManagedByParent' does not work as documented. The fact that there
                // is a parent means it is managed and 'lifecycleManagedByParent' if ignored.
                childOptions.lifecycleManagedByParent = true;
                childOptions.parentSession = e.session;
            }
            delay += Math.max(launch.delayMs || 0, 0);
            const child = new CDebugChainedSessionItem(cDbgParent, launch, childOptions);
            const folder = this.getWsFolder(launch.folder, e.session.workspaceFolder, launch.name);
            if (!folder && launch.folder) {
                vscode.window.showErrorMessage(
                    `Chained configuration for '${launch.name}' specified folder is '${launch.folder}' which is not part of the current workspace. Cannot launch this configuration.`,
                );
                continue;
            }
            setTimeout(() => {
                vscode.debug.startDebugging(folder, launch.name, childOptions).then(
                    (success) => {
                        if (!success) {
                            vscode.window.showErrorMessage("Failed to launch chained configuration " + launch.name);
                        }
                        CDebugChainedSessionItem.RemoveItem(child);
                    },
                    (e) => {
                        vscode.window.showErrorMessage(`Failed to launch chained configuration ${launch.name}: ${e}`);
                        CDebugChainedSessionItem.RemoveItem(child);
                    },
                );
            }, delay);
            if (launch && launch.detached && count > 0) {
                try {
                    const prevStartedPromise = new Promise<vscode.DebugSessionCustomEvent>((resolve, reject) => {
                        this.serverStartedEvent = new ServerStartedPromise(launch.name, prevStartedPromise, resolve, reject);
                    });
                    let to: NodeJS.Timeout | undefined = undefined;
                    to = setTimeout(() => {
                        if (this.serverStartedEvent) {
                            this.serverStartedEvent.reject(new Error(`Timeout starting chained session: ${launch.name}`));
                            this.serverStartedEvent = null;
                        }
                        to = undefined;
                    }, 5000);
                    await prevStartedPromise;
                    if (to) {
                        clearTimeout(to);
                    }
                } catch (e) {
                    vscode.window.showErrorMessage(`Detached chained configuration launch failed? Aborting rest. Error: ${e}`);
                    break; // No more children after this error
                }
                delay = 0;
            } else {
                delay += 5;
            }
        }
    }

    private endChainedConfigs(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren()) {
            // Note that we may not be the root, but we have children. Also we do not modify the tree while iterating it
            const deathList: CDebugSession[] = [];
            const orphanList: CDebugSession[] = [];
            mySession.broadcastDFS((s) => {
                if (s === mySession) {
                    return;
                }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    deathList.push(s); // Qualifies to be terminated
                } else {
                    orphanList.push(s); // This child is about to get orphaned
                }
            }, false);

            // According to current scheme, there should not be any orphaned children.
            while (orphanList.length > 0) {
                const s = orphanList.pop();
                if (s) {
                    s.moveToRoot(); // Or should we move to our parent. TODO: fix for when we are going to have grand children
                }
            }

            while (deathList.length > 0) {
                const s = deathList.pop();
                if (!s || !s.session) {
                    continue;
                }
                // We cannot actually use the following API. We have to do this ourselves. Probably because we own
                // the lifetime management.
                // vscode.debug.stopDebugging(s.session);
                ServerConsoleLog(`Sending custom-stop-debugging to ${s.session.name} PID=${process.pid}`);
                s.session.customRequest("custom-stop-debugging", e.body.info).then(
                    () => {},
                    (reason) => {
                        vscode.window.showErrorMessage(`mcu-debug: Bug? session.customRequest('set-stop-debugging-type', ... failed ${reason}\n`);
                    },
                );
            }
            // Following does not work. Apparently, a customRequest cannot be sent probably because this session is already
            // terminating.
            // mySession.session.customRequest('notified-children-to-terminate');
        }
    }

    private resetOrResartChained(e: vscode.DebugSessionCustomEvent, type: "reset" | "restart") {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession && mySession.hasChildren()) {
            mySession.broadcastDFS((s) => {
                if (s === mySession) {
                    return;
                }
                if (s.config.pvtMyConfigFromParent.lifecycleManagedByParent) {
                    s.session.customRequest("reset-device", type).then(
                        () => {},
                        (reason) => {},
                    );
                }
            }, false);
        }
    }

    private getWsFolder(folder: string, def: vscode.WorkspaceFolder | undefined, childName: string): vscode.WorkspaceFolder | undefined {
        if (folder && def) {
            const orig = folder;
            const normalize = (fsPath: string) => {
                fsPath = path.normalize(fsPath).replace(/\\/g, "/");
                fsPath = fsPath === "/" ? fsPath : fsPath.replace(/\/+$/, "");
                if (process.platform === "win32") {
                    fsPath = fsPath.toLowerCase();
                }
                return fsPath;
            };
            // Folder is always a full path name
            folder = normalize(folder);
            for (const f of vscode.workspace.workspaceFolders || []) {
                const tmp = normalize(f.uri.fsPath);
                if (f.uri.fsPath === folder || f.name === folder || tmp === folder) {
                    return f;
                }
            }
            vscode.window.showInformationMessage(
                `Chained configuration for '${childName}' specified folder is '${orig}' normalized path is '${folder}'` + " did not match any workspace folders. Using parents folder.",
            );
        }
        return def;
    }

    private getCurrentArgs(session: vscode.DebugSession): ConfigurationArguments | undefined {
        if (!session) {
            const currentSession = vscode.debug.activeDebugSession;
            if (!currentSession || currentSession.type !== "mcu-debug") {
                return undefined;
            }
            session = currentSession;
        }
        const ourSession = CDebugSession.FindSession(session);
        if (ourSession) {
            return ourSession.config as ConfigurationArguments;
        }
        return session.configuration as unknown as ConfigurationArguments;
    }

    // Assuming 'session' valid and it is a mcu-debug session
    private isDebugging(session: vscode.DebugSession) {
        const args = this.getCurrentArgs(session);
        return args?.noDebug !== true; // If it is exactly equal to 'true' we are doing a 'run without debugging'
    }

    private receivedStopEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession) {
            mySession.status = "stopped";
            this.liveWatchProvider?.debugStopped(e.session);
            if (mySession.swo) {
                mySession.swo.debugStopped();
            }
            if (mySession.rtt) {
                mySession.rtt.debugStopped();
            }
        }
    }

    private receivedContinuedEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession) {
            mySession.status = "running";
            this.liveWatchProvider?.debugContinued(e.session);
            if (mySession.swo) {
                mySession.swo.debugContinued();
            }
            if (mySession.rtt) {
                mySession.rtt.debugContinued();
            }
        }
    }

    private receivedEvent(e: vscode.DebugSessionCustomEvent) {
        const str = JSON.stringify(e.body);
        // console.log(`Event: ${e.body.category}, ${e.body.action}, ${e.body.label}, ${str}`);
        Reporting.sendEvent(e.event, { body: str });
    }

    private receivedSWOConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.GetSession(e.session);
        if (e.body.type === "socket") {
            let src: SocketSWOSource | PeMicroSocketSource;
            const decoderSpec = mySession.config.swoConfig.pre_decoder;
            if (mySession.config.servertype === "pe") {
                src = new PeMicroSocketSource(e.body.port, decoderSpec);
            } else {
                src = new SocketSWOSource(e.body.port, decoderSpec);
            }
            mySession.swoSource = src;
            this.initializeSWO(e.session, e.body.args);
            src.start().then(
                () => {
                    MCUDebugChannel.debugMessage(`Connected after ${src.nTries} tries`);
                    // Do nothing...
                },
                (e) => {
                    vscode.window.showErrorMessage(`Could not open SWO TCP port ${e.body.port} ${e} after ${src.nTries} tries`);
                },
            );
            Reporting.sendEvent("SWO", { Source: "Socket" });
            return;
        } else if (e.body.type === "fifo") {
            mySession.swoSource = new FifoSWOSource(e.body.path);
            Reporting.sendEvent("SWO", { Source: "FIFO" });
        } else if (e.body.type === "file") {
            mySession.swoSource = new FileSWOSource(e.body.path);
            Reporting.sendEvent("SWO", { Source: "File" });
        } else if (e.body.type === "serial") {
            mySession.swoSource = new SerialSWOSource(e.body.device, e.body.baudRate);
            Reporting.sendEvent("SWO", { Source: "Serial" });
        } else if (e.body.type === "usb") {
            mySession.swoSource = new UsbSWOSource(e.body.device, e.body.port);
            Reporting.sendEvent("SWO", { Source: "USB" });
        }

        this.initializeSWO(e.session, e.body.args);
    }

    private receivedRTTConfigureEvent(e: vscode.DebugSessionCustomEvent) {
        if (e.body.type === "socket") {
            const decoder: RTTCommonDecoderOpts = e.body.decoder;
            if (decoder.type === "console" || decoder.type === "binary") {
                Reporting.sendEvent("RTT", { Source: "Socket= Console" });
                this.rttCreateTerninal(e, decoder as RTTConsoleDecoderOpts);
            } else {
                Reporting.sendEvent("RTT", { Source: `Socket= ${decoder.type}` });
                if (!decoder.ports) {
                    this.createRTTSource(e, decoder.tcpPort, decoder.port);
                } else {
                    for (let ix = 0; ix < decoder.ports.length; ix = ix + 1) {
                        // Hopefully ports and tcpPorts are a matched set
                        this.createRTTSource(e, decoder.tcpPorts[ix], decoder.ports[ix]);
                    }
                }
            }
        } else {
            MCUDebugChannel.debugMessage("Error: receivedRTTConfigureEvent: unknown type: " + e.body.type);
        }
    }

    // The returned value is a connection source. It may still be in disconnected
    // state.
    private createRTTSource(e: vscode.DebugSessionCustomEvent, tcpPort: string, channel: number): Promise<SocketRTTSource> {
        const mySession = CDebugSession.GetSession(e.session);
        return new Promise((resolve, reject) => {
            let src = mySession.rttPortMap[channel];
            if (src) {
                resolve(src);
                return;
            }
            let decoderSpec = mySession.config.rttConfig?.enabled && mySession.config.rttConfig?.pre_decoder;
            if (decoderSpec && mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
                decoderSpec = undefined;
            }
            if (mySession.config.servertype === "jlink") {
                src = new JLinkSocketRTTSource(tcpPort, channel, decoderSpec);
            } else {
                src = new SocketRTTSource(tcpPort, channel, decoderSpec);
            }
            mySession.rttPortMap[channel] = src; // Yes, we put this in the list even if start() can fail
            resolve(src); // Yes, it is okay to resolve it even though the connection isn't made yet
            src.start()
                .then(() => {
                    if (!mySession.config.rttConfig?.useBuiltinRTT?.enabled) {
                        mySession.session.customRequest("rtt-poll");
                    }
                })
                .catch((e) => {
                    vscode.window.showErrorMessage(`Could not connect to RTT TCP port ${tcpPort} ${e}`);
                    // reject(e);
                });
        });
    }

    private cleanupRTTTerminals() {
        this.rttTerminals = this.rttTerminals.filter((t) => {
            if (!t.inUse) {
                t.dispose();
                return false;
            }
            return true;
        });
    }

    private rttCreateTerninal(e: vscode.DebugSessionCustomEvent, decoder: RTTConsoleDecoderOpts) {
        this.createRTTSource(e, decoder.tcpPort, decoder.port).then((src: SocketRTTSource) => {
            for (const terminal of this.rttTerminals) {
                const success = !terminal.inUse && terminal.tryReuse(decoder, src);
                if (success) {
                    if (vscode.debug.activeDebugConsole) {
                        vscode.debug.activeDebugConsole.appendLine(`Reusing RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`);
                    }
                    return;
                }
            }
            const newTerminal = new RTTTerminal(this.context, decoder, src);
            this.rttTerminals.push(newTerminal);
            if (vscode.debug.activeDebugConsole) {
                vscode.debug.activeDebugConsole.appendLine(`Created RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`);
            }
        });
    }

    private terminalClosed(terminal: vscode.Terminal) {
        this.rttTerminals = this.rttTerminals.filter((t) => t.terminal !== terminal);
    }

    private initializeSWO(session: vscode.DebugSession, args: ConfigurationArguments) {
        const mySession = CDebugSession.FindSession(session);
        if (!mySession) {
            return;
        }
        if (!mySession.swoSource) {
            vscode.window.showErrorMessage("Tried to initialize SWO Decoding without a SWO data source");
            return;
        }

        if (!mySession.swo) {
            mySession.swo = new SWOCore(session, mySession.swoSource, args, this.context.extensionPath);
        }
    }

    private initializeRTT(session: vscode.DebugSession, args: ConfigurationArguments) {
        const mySession = CDebugSession.FindSession(session);
        if (mySession && !mySession.rtt) {
            mySession.rtt = new RTTCore(mySession.rttPortMap, args, this.context.extensionPath);
        }
    }

    private addLiveWatchExpr() {
        this.liveWatchWebview.add();
    }

    private addToLiveWatch(arg: any) {
        if (!arg || !arg.sessionId) {
            return;
        }
        const mySession = CDebugSession.FindSessionById(arg.sessionId);
        if (!mySession) {
            vscode.window.showErrorMessage(`addToLiveWatch: Unknown debug session id ${arg.sessionId}`);
            return;
        }
        const parent = arg.container;
        const parentVarRef = parent ? parent.variablesReference : 0;
        if (!parent || !isVarRefGlobalOrStatic(parentVarRef)) {
            vscode.window.showErrorMessage(`Cannot add ${arg.variable?.evaluateName} to Live Watch. Must be a global or static variable`);
            return;
        }
        const expr = arg.variable?.evaluateName;
        this.liveWatchProvider.addWatchExpr(expr);
    }

    private removeLiveWatchExpr(node: any) {
        this.liveWatchProvider.removeWatchExpr(node);
    }

    private editLiveWatchExpr(node: any) {
        this.liveWatchProvider.editNode(node);
    }

    private moveUpLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveUpNode(node);
    }

    private moveDownLiveWatchExpr(node: any) {
        this.liveWatchProvider.moveDownNode(node);
    }

    private addSelectionToLiveWatch() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            const text = editor.document.getText(selection).trim();
            if (text) {
                this.liveWatchProvider.addWatchExpr(text);
            } else {
                const wordRange = editor.document.getWordRangeAtPosition(selection.active);
                if (wordRange) {
                    const word = editor.document.getText(wordRange);
                    this.liveWatchProvider.addWatchExpr(word);
                }
            }
        }
    }

    private startLiveWatchRecording() {
        this.liveWatchProvider.startRecording();
    }

    private stopLiveWatchRecording() {
        this.liveWatchProvider.stopRecording();
    }

    private openLiveWatchGraph() {
        this.liveWatchGrapher.openGraph(() => this.liveWatchProvider.gatherLeafExprs());
    }

    private async generateMcpConfig() {
        const bridgePath = path.join(this.context.extensionPath, "support", "mcp-bridge.js");
        const nodeCmd = process.execPath; // VS Code's embedded Node.js binary

        // Ask the user which format they want
        const choice = await vscode.window.showQuickPick([
            { label: "VS Code Native MCP", description: "Generate .vscode/mcp.json", id: "vscode" },
            { label: "Generic MCP", description: "Generate .vscode/mcu-debug-mcp.json (for Cursor, Claude Desktop, Antigravity, etc.)", id: "generic" },
        ], {
            placeHolder: "Select the MCP configuration format for your AI agent",
        });
        if (!choice) return;

        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            // Fallback: open as untitled document
            const fallbackJson = JSON.stringify(this.buildGenericConfig(nodeCmd, bridgePath), null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: `// Copy this configuration into your AI agent's MCP settings file:\n\n${fallbackJson}`,
                language: "jsonc"
            });
            await vscode.window.showTextDocument(doc);
            return;
        }

        const wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const vscodeDir = path.join(wsPath, ".vscode");

        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(vscodeDir));

            if (choice.id === "vscode") {
                // VS Code native format: .vscode/mcp.json
                const vscodeMcpPath = path.join(vscodeDir, "mcp.json");
                const vscodeConfig = {
                    servers: {
                        "mcu-debug": {
                            type: "stdio",
                            command: nodeCmd,
                            args: [bridgePath],
                            env: {
                                ELECTRON_RUN_AS_NODE: "1"
                            }
                        }
                    },
                    inputs: []
                };
                const content = JSON.stringify(vscodeConfig, null, 2) + "\n";
                await vscode.workspace.fs.writeFile(vscode.Uri.file(vscodeMcpPath), Buffer.from(content, "utf8"));
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(vscodeMcpPath));
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage("Generated VS Code native MCP config: .vscode/mcp.json");
            } else {
                // Generic format: .vscode/mcu-debug-mcp.json
                const genericPath = path.join(vscodeDir, "mcu-debug-mcp.json");
                const genericConfig = this.buildGenericConfig(nodeCmd, bridgePath);
                const content = `// Automatically generated by MCU-Debug\n// Copy this into your AI agent's MCP configuration (e.g. Antigravity, Cursor Settings, Claude Desktop config, etc.)\n// See details in "For humans" section of .vscode/mcp-debug-mcp.md\n\n${JSON.stringify(genericConfig, null, 2)}\n`;
                await vscode.workspace.fs.writeFile(vscode.Uri.file(genericPath), Buffer.from(content, "utf8"));
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(genericPath));
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage("Generated generic MCP config: .vscode/mcu-debug-mcp.json");
            }

            // Always generate the AI instruction doc
            await this.generateMcpDoc(vscodeDir);

        } catch (err) {
            console.error("Failed to generate MCP configuration", err);
            vscode.window.showErrorMessage("Failed to generate MCP configuration. Check the output console.");
        }
    }

    private buildGenericConfig(nodeCmd: string, bridgePath: string) {
        return {
            mcpServers: {
                "mcu-debug": {
                    command: nodeCmd,
                    args: [bridgePath],
                    env: {
                        ELECTRON_RUN_AS_NODE: "1"
                    }
                }
            }
        };
    }

    private async generateMcpDoc(vscodeDir: string) {
        const docPath = path.join(vscodeDir, "mcu-debug-mcp.md");
        const docStr = [
            "# MCU-Debug MCP Tool Reference",
            "",
            "> **If you are an AI assistant reading this file: STOP. Do NOT browse the MCU-Debug source code or write any Python/Node.js scripts to read debug variables. You already have direct native MCP tools. Use them.**",
            "",
            "## Overview",
            "",
            "You have access to the following MCP tools. They are already wired into the running VS Code debug session. Call them directly.",
            "",
            "---",
            "",
            "### Tool: `get_livewatch_variables`",
            "**Purpose**: Returns a snapshot of ALL currently-watched C/C++ variables and their real-time values from the target MCU.",
            "",
            "**Input**: None.",
            "",
            "**Output** (JSON):",
            "| status | Description |",
            "|---|---|",
            '| `"OK"` | Success. The `variables` field contains `{ "expression": "value" }` pairs. If any value is `"<STRUCT_OR_ARRAY_UNEXPANDED>"`, that variable is a struct/array that must be expanded via `expand_livewatch_struct` before its children become readable. |',
            '| `"NO_DEBUG_SESSION"` | No active debug session. Tell the user to start debugging (F5). Do NOT try to work around this. |',
            '| `"NO_VARIABLES"` | Debug session is active but the Live Watch panel is empty. Use `add_livewatch_variable` to add variables, or ask the user. |',
            '| `"ERROR"` | An unexpected error occurred. The `error` field contains details. |',
            "",
            "---",
            "",
            "### Tool: `add_livewatch_variable`",
            '**Purpose**: Adds a C/C++ expression to the Live Watch panel so it gets polled from the MCU in real-time.',
            "",
            '**Input**: `{ "expr": "g_motor.speed" }` — any valid C expression that GDB can evaluate.',
            "",
            "**Output** (JSON):",
            "| status | Description |",
            "|---|---|",
            '| `"OK"` | Success. The `expression` field contains the added expression. |',
            '| `"NO_DEBUG_SESSION"` | No active debug session. |',
            '| `"ERROR"` | Failed to add. The `error` field contains details (e.g., invalid expression). |',
            "",
            "---",
            "",
            "### Tool: `expand_livewatch_struct`",
            "**Purpose**: Expands an unexpanded struct or array in the Live Watch to reveal its children/members.",
            "",
            '**Input**: `{ "expr": "g_motor" }` — the exact expression string as shown in `get_livewatch_variables`.',
            "",
            "**Output** (JSON):",
            "| status | Description |",
            "|---|---|",
            '| `"OK"` | Expansion succeeded. Call `get_livewatch_variables` again to see the new children. |',
            '| `"NO_DEBUG_SESSION"` | No active debug session. |',
            '| `"NOT_FOUND"` | The expression was not found in the Live Watch panel. Check the exact spelling. |',
            '| `"NOT_EXPANDABLE"` | The expression is a leaf variable (scalar), not a struct/array. It cannot be expanded. |',
            '| `"ERROR"` | An unexpected error during expansion. The `error` field contains details. |',
            "",
            "---",
            "",
            "### Tool: `record_livewatch_variables`",
            "**Purpose**: Automatically records Live Watch values for a fixed duration and returns a timeseries data table.",
            "",
            '**Input**: `{ "duration_ms": 5000 }` — duration in milliseconds. Will be capped to the user\'s configured maximum (default: 30s).',
            "",
            "**Output** (JSON):",
            "| status | Description |",
            "|---|---|",
            '| `"OK"` | Recording completed. `duration_ms`, `sample_count`, and `records` (array of `{ time, values }`) are present. |',
            '| `"NO_DEBUG_SESSION"` | No active debug session. |',
            '| `"NO_VARIABLES"` | No leaf variables are available to record. Add or expand variables first. |',
            '| `"MANUAL_MODE_REQUIRED"` | The user has enabled manual recording mode. You **must** use the `record_livewatch_variables_manual` tool instead. Do NOT ask the user — just switch tools. |',
            '| `"CANCELLED_OR_EMPTY"` | The user cancelled via the notification, or no data was captured. `records` will be an empty array. |',
            '| `"ERROR"` | Invalid input or unexpected error. The `error` field contains details. |',
            "",
            "---",
            "",
            "### Tool: `record_livewatch_variables_manual`",
            '**Purpose**: Records Live Watch values with **manual user-controlled start and stop**. The user clicks "Start" and "Stop" buttons inside VS Code. This tool requires NO input parameters.',
            "",
            "**Input**: None.",
            "",
            "**Important behavior**:",
            '- This tool will **block for a long time** while waiting for the user to physically interact with their hardware and click buttons. This is completely normal. Do NOT abort or time out early.',
            "- The maximum wall-clock time is controlled by the user's `mcu-debug.mcpManualRecordingMaxDuration` setting (default: 60s).",
            "",
            "**Output** (JSON):",
            "| status | Description |",
            "|---|---|",
            '| `"OK"` | Recording completed. `end_reason` is `"USER_STOPPED"` or `"MAX_DURATION_REACHED"`. `sample_count` and `records` are present. |',
            '| `"NO_DEBUG_SESSION"` | No active debug session. |',
            '| `"NO_VARIABLES"` | No leaf variables are available to record. |',
            '| `"CANCELLED_BY_USER"` | The user clicked "Cancel" or dismissed the Start prompt. Do NOT retry aggressively. Politely inform the user and wait. |',
            '| `"CANCELLED_OR_EMPTY"` | Recording started but produced no data (e.g., debug session ended mid-recording). |',
            "",
            "---",
            "",
            "## CRITICAL RULES FOR AI AGENTS",
            "",
            '1. **DO NOT** write Python scripts, Node.js scripts, or any other code to read debug variables. The MCP tools handle everything.',
            '2. **DO NOT** try to parse GDB output, memory dumps, or ELF files to get variable values.',
            '3. **DO NOT** look through the MCU-Debug extension source code trying to understand "how to connect". You are ALREADY connected via MCP.',
            '4. **DO NOT** ask the user "how should I read the variables?" — just call `get_livewatch_variables`.',
            '5. If you see `"<STRUCT_OR_ARRAY_UNEXPANDED>"` in any variable value, call `expand_livewatch_struct` on that expression immediately.',
            '6. If you get `"NO_DEBUG_SESSION"`, tell the user: "Please start a debug session (F5) and I\'ll read the variables for you."',
            '7. If you need a variable that isn\'t being watched, call `add_livewatch_variable` to add it, wait a moment, then call `get_livewatch_variables` again.',
            '8. If `record_livewatch_variables` returns `"MANUAL_MODE_REQUIRED"`, switch to `record_livewatch_variables_manual` without asking the user.',
            '9. If `record_livewatch_variables_manual` returns `"CANCELLED_BY_USER"`, do NOT retry automatically. Inform the user politely and wait.',
            "",
            "## For Humans: Setup Instructions",
            "",
            "This project has MCU-Debug MCP integration configured. To use it with your AI assistant:",
            "",
            "- **VS Code**: The `.vscode/mcp.json` file is already set up. Your AI agent will automatically discover the MCU-Debug tools.",
            '- **Antigravity**: Go to Open Antigravity User Settings, click "Open MCP Config", and paste the contents of `.vscode/mcu-debug-mcp.json`.',
            '- **Cursor**: Go to Settings > Features > MCP, click "Add New MCP Server", and paste the contents of `.vscode/mcu-debug-mcp.json`.',
            "- **Claude Desktop / Other**: Copy the contents of `.vscode/mcu-debug-mcp.json` into your client's MCP configuration file.",
            "",
            "## VS Code Settings Reference",
            "",
            "| Setting | Type | Default | Description |",
            "|---|---|---|---|",
            "| `mcu-debug-ai.mcpRequireManualRecording` | boolean | false | If enabled, `record_livewatch_variables` returns `MANUAL_MODE_REQUIRED` and agents must use the manual tool. |",
            "| `mcu-debug-ai.mcpRecordingMaxDuration` | number | 30 | Max recording duration in seconds for automatic mode. |",
            "| `mcu-debug-ai.mcpManualRecordingMaxDuration` | number | 60 | Max recording duration in seconds for manual mode. |",
            "",
        ].join("\n");
        await vscode.workspace.fs.writeFile(vscode.Uri.file(docPath), Buffer.from(docStr, "utf8"));
    }
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        Reporting.activateTelemetry(context);
        MCUDebugChannel.createDebugChannel();
        const packageJson = context.extension.packageJSON;
        const version = packageJson.version || "unknown";
        MCUDebugChannel.debugMessage(`Starting mcu-debug extension. Version = ${version}, Path = ${context.extensionPath}, PID=${process.pid}`);
    } catch (_e) {
        /* empty */
    }
    const ret = new MCUDebugExtension(context);
    await ret.initialize();
    return ret;
}

export async function deactivate() {}
