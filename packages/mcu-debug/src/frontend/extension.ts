// Copyright (c) 2026 MCU-Debug Authors.
// This source code is licensed under the MIT license found in the
// LICENSE-MIT file in the root directory of this source tree.

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { MCUDebugChannel } from "./dbgmsgs";
import { LiveWatchTreeProvider, LiveVariableNode } from "./views/live-watch";
import { LiveWatchGrapher } from "./views/live-watch-grapher";
import { LiveWatchMcpServer } from "./mcp-server";
import { EditableTreeViewProvider } from "./webview_tree/editable-tree";
import { CockpitPanel } from "./views/CockpitPanel";
import { SerialPortManager } from "../common/serial-manager";

import { RTTCore, SWOCore } from "../common/swo/swo-core";
import { ConfigurationArguments, RTTCommonDecoderOpts, RTTConsoleDecoderOpts, MCUDebugKeys, ChainedEvents, ChainedConfig, SerialConfig, getHelperExecutable } from "../adapter/servers/common";
import { Reporting } from "../analytics/reporting";

import { McuDebugConfigurationProvider } from "./configprovider";
import { VscodeAdapter } from "./vscode-adapter";
import { setHostAdapter, IDebugSession } from "../common/host-adapter";
import { JLinkSocketRTTSource, SocketRTTSource, SocketSWOSource, PeMicroSocketSource, SocketUARTSource, SocketIOSource } from "../common/swo/sources/socket";
import { FifoSWOSource } from "../common/swo/sources/fifo";
import { FileSWOSource } from "../common/swo/sources/file";
import { SerialSWOSource } from "../common/swo/sources/serial";
import { UsbSWOSource } from "../common/swo/sources/usb";
import { SymbolInformation, SymbolScope } from "../adapter/symbols";
import { IOTerminal } from "./io-terminal";
import { GDBServerConsole } from "./server-console";
import { CDebugSession, CDebugChainedSessionItem } from "../common/cli-session";
import { ServerConsoleLog } from "../adapter/server-console-log";
import { logger } from '../common/logger';
import { VscodeOutputChannelTransport } from './vscode-transport';
import { isVarRefGlobalOrStatic } from "../adapter/var-scopes";
import { getWSLNetworkingMode, ProvisioningResults, ProxyProvisionRequest, setDevelopmentModeEnvVars } from "@mcu-debug/shared";
import { createRTTSource, handleRTTConfigureEvent } from "../common/rtt-source";
import { AICockpit } from "./ai-cockpit";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { checkProxyCommand, probeAgentStatusCommand, promptProxyInstallOnce } from "./activate-proxy";
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
    ) { }
}

export class MCUDebugExtension {
    private gdbServerConsole: GDBServerConsole | null = null;

    private liveWatchProvider!: LiveWatchTreeProvider;
    private liveWatchWebview!: EditableTreeViewProvider;
    private liveWatchGrapher!: LiveWatchGrapher;
    private liveWatchMcpServer!: LiveWatchMcpServer;
    private mcpConfigurationTask: Promise<void> = Promise.resolve();
    public cockpitPanel!: CockpitPanel;

    private SVDDirectory: SVDInfo[] = [];
    private functionSymbols: SymbolInformation[] = [];
    private serverStartedEvent: ServerStartedPromise | null = null;
    private serialPortManager: SerialPortManager;

    constructor(private context: vscode.ExtensionContext) {
        this.serialPortManager = new SerialPortManager();
    }

    public async initialize() {
        const context: vscode.ExtensionContext = this.context;
        const config = vscode.workspace.getConfiguration("mcu-debug");
        this.startServerConsole(context, config.get(MCUDebugKeys.SERVER_LOG_FILE_NAME, "")); // Creates the object only; the TCP server is started on first use

        try {
            // Auto-write/update wrapper scripts
            this.ensureWrapperScripts(context.extension.extensionPath);

            // Check PATH and prompt if necessary (delayed by 20 seconds)
            setTimeout(() => {
                const promptDismissedKey = "mcu-debug.cliPromptDismissed";
                if (!this.isBinDirInPath() && !context.globalState.get<boolean>(promptDismissedKey, false)) {
                    vscode.window.showInformationMessage(
                        "The mcu-debug CLI tools are ready. Would you like to add them to your PATH?",
                        "Yes",
                        "No",
                        "Don't Ask Again"
                    ).then(selection => {
                        if (selection === "Yes") {
                            vscode.commands.executeCommand("mcu-debug.installCli");
                        } else if (selection === "No") {
                            return;
                        } else if (selection === "Don't Ask Again") {
                            context.globalState.update(promptDismissedKey, true);
                        }
                    });
                }
            }, 20000);
        } catch (error) {
            MCUDebugChannel.debugMessage("Failed to write wrapper files needed by CLI tools: " + error);
            vscode.window.showWarningMessage("Failed to write wrapper files needed by CLI tools: " + error);
        }

        this.cockpitPanel = new CockpitPanel(context.extensionUri);
        AICockpit.getInstance(context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(CockpitPanel.viewId, this.cockpitPanel),
            vscode.commands.registerCommand("mcu-debug.cockpit.addUart", () => {
                // TODO: show port picker and call this.cockpitPanel.addTab(new UartManagedTab(...))
                vscode.window.showInformationMessage("Add UART — not yet implemented");
            }),
            // The webview's right-click menu passes back the data-vscode-context of the
            // element under the pointer, which carries the tab that was clicked.
            vscode.commands.registerCommand("mcu-debug.cockpit.clear", (menuContext?: { tabId?: string }) => {
                this.cockpitPanel.clearTab(menuContext?.tabId);
            }),
        );

        this.liveWatchProvider = new LiveWatchTreeProvider(this.context);
        this.liveWatchWebview = new EditableTreeViewProvider(this.context.extensionUri, this.liveWatchProvider);
        this.liveWatchGrapher = new LiveWatchGrapher(this.context.extensionPath);
        this.liveWatchMcpServer = new LiveWatchMcpServer(this.liveWatchProvider);
        
        this.liveWatchProvider.setRefreshCallback(() => this.liveWatchWebview.refresh());
        this.liveWatchProvider.setUpdateItemsCallback((items) => this.liveWatchWebview.updateComposite(items));
        this.liveWatchProvider.setGrapher(this.liveWatchGrapher);
        
        await this.applyLegacyMcpSetting();
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("mcu-ai-debug.enableMcp")) {
                this.mcpConfigurationTask = this.mcpConfigurationTask
                    .then(() => this.applyLegacyMcpSetting())
                    .catch((err) => vscode.window.showWarningMessage(`Legacy MCP setting failed: ${err}`));
            }
        }));
        context.subscriptions.push({ dispose: () => this.liveWatchMcpServer.dispose() });

        context.subscriptions.push(vscode.window.registerWebviewViewProvider("mcu-debug.liveWatch", this.liveWatchWebview));

        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.VARIABLE_DISPLAY_MODE}`, config.get(MCUDebugKeys.VARIABLE_DISPLAY_MODE, true));

        const uriHandler = new MyUriHandler(this.context);
        context.subscriptions.push(
            vscode.window.registerUriHandler(uriHandler),
            vscode.commands.registerCommand("mcu-debug.varHexModeTurnOn", this.variablesNaturalMode.bind(this, false)),
            vscode.commands.registerCommand("mcu-debug.varHexModeTurnOff", this.variablesNaturalMode.bind(this, true)),
            vscode.commands.registerCommand("mcu-debug.toggleVariableHexFormat", this.toggleVariablesHexMode.bind(this)),

            vscode.commands.registerCommand("mcu-debug.examineMemory", this.examineMemory.bind(this)),

            vscode.commands.registerCommand("mcu-debug.resetDevice", this.resetDevice.bind(this)),
            vscode.commands.registerCommand("mcu-debug.pauseAll", this.pauseAll.bind(this)),
            vscode.commands.registerCommand("mcu-debug.resumeAll", this.resumeAll.bind(this)),

            vscode.commands.registerCommand("mcu-debug.listAvailableSerialPorts", (noDisplay?: boolean) => this.serialPortManager.listAvailablePortsCmd(noDisplay)),

            // Two separate diagnostics, because "proxy" means two things. This one is about the
            // companion *extension*: is it reachable, and do the versions agree? The answer
            // cannot be obtained from vscode.extensions in a remote window -- see
            // activate-proxy.ts -- so this asks the proxy directly.
            vscode.commands.registerCommand("mcu-debug.checkProxyExtension", () => checkProxyCommand(context)),
            // ...and this one is about the long-lived `mdbg proxy` daemon (the Probe Agent) on
            // the machine with the probe, which outlives every window and was invisible from here.
            vscode.commands.registerCommand("mcu-debug.probeAgentStatus", () => probeAgentStatusCommand(context)),

            vscode.commands.registerCommand("mcu-debug.liveWatch.addExpr", this.addLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.removeExpr", this.removeLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.editExpr", this.editLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.addToLiveWatch", this.addToLiveWatch.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.moveUp", this.moveUpLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-debug.liveWatch.moveDown", this.moveDownLiveWatchExpr.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.toggleBatchEdit", this.toggleLiveWatchBatchEdit.bind(this)),

            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.addSelectionToLiveWatch", this.addSelectionToLiveWatch.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.saveSnapshot", this.saveLiveWatchSnapshot.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.startRecording", this.startLiveWatchRecording.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.stopRecording", this.stopLiveWatchRecording.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.liveWatch.openGraph", this.openLiveWatchGraph.bind(this)),
            vscode.commands.registerCommand("mcu-ai-debug.generateMcpConfig", this.generateMcpConfig.bind(this)),

            vscode.commands.registerCommand("mcu-debug.depositProvision", (data: ProvisioningResults) => this.depositProvision(data)),

            vscode.commands.registerCommand("mcu-debug.cockpit.startDebugSession", (arg: string | undefined) => {
                AICockpit.getInstance(this.context)?.startDebugSession(arg);
            }),

            vscode.commands.registerCommand("mcu-debug.installCli", () => {
                context.globalState.update("mcu-debug.cliPromptDismissed", true);
                const installerScriptPath = path.join(context.extensionPath, "support", "install-cli.js");
                const terminal = vscode.window.createTerminal({
                    name: "mcu-debug CLI Installer",
                });
                terminal.sendText(`node "${installerScriptPath}"`);
                terminal.show();
            }),

            vscode.workspace.onDidChangeConfiguration(this.settingsChanged.bind(this)),
            vscode.debug.onDidReceiveDebugSessionCustomEvent(this.receivedCustomEvent.bind(this)),
            vscode.debug.onDidStartDebugSession(this.debugSessionStarted.bind(this)),
            vscode.debug.onDidTerminateDebugSession(this.debugSessionTerminated.bind(this)),

            vscode.debug.registerDebugConfigurationProvider("mcu-debug", new McuDebugConfigurationProvider(context, this.serialPortManager)),
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
        let session: IDebugSession | null = MCUDebugExtension.getActiveCDSession();
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

    private pauseAll() {
        for (const s of CDebugSession.CurrentSessions) {
            if (s.status === "running") {
                s.session.customRequest("pause", { threadId: 1 });
            }
        }
    }

    private resumeAll() {
        for (const s of CDebugSession.CurrentSessions) {
            if (s.status === "stopped") {
                s.session.customRequest("continue", { threadId: 1, singleThread: false });
            }
        }
    }

    private updateSessionContext() {
        const sessions = CDebugSession.CurrentSessions;
        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.CHAINED_SESSIONS_ACTIVE}`, sessions.length > 1);
        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.HAS_RUNNING_SESSIONS}`, sessions.some((s) => s.status === "running"));
        vscode.commands.executeCommand("setContext", `mcu-debug:${MCUDebugKeys.HAS_STOPPED_SESSIONS}`, sessions.some((s) => s.status === "stopped"));
    }

    /**
     * Only constructs the console. The TCP server behind it is started lazily, on the first
     * debug session that asks for its port -- we activate on `onStartupFinished`, so starting it
     * here would bind a port in every window whether or not it is ever used to debug. A failure
     * to bind now surfaces from resolveDebugConfiguration(), where it is in context and where the
     * user can act on it.
     */
    private startServerConsole(context: vscode.ExtensionContext, logFName: string = ""): void {
        try {
            this.gdbServerConsole = new GDBServerConsole(context, logFName);
        } catch (e: any) {
            this.gdbServerConsole?.dispose();
            this.gdbServerConsole = null;
            vscode.window.showErrorMessage(`Could not create gdb-server-console. Please report this problem. ${e.toString()}`);
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
            () => { },
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
        this.updateSessionContext();

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
            this.updateSessionContext();
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
            case "post-initialized":
                this.receivedPostInitializedEvent(e);
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
                if (!session.parentSession) {
                    void vscode.commands.executeCommand("mcu-debug.liveWatch.focus");
                }
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

    private receivedPostInitializedEvent(e: vscode.DebugSessionCustomEvent) {
        // Handle the post-initialized event here
        this.liveWatchProvider.postInitializeNotification(e);
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
                    () => { },
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
                        () => { },
                        (reason) => { },
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

    private getCurrentArgs(session: IDebugSession | null | undefined): ConfigurationArguments | undefined {
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
    private isDebugging(session: IDebugSession) {
        const args = this.getCurrentArgs(session);
        return args?.noDebug !== true; // If it is exactly equal to 'true' we are doing a 'run without debugging'
    }

    private receivedStopEvent(e: vscode.DebugSessionCustomEvent) {
        const mySession = CDebugSession.FindSession(e.session);
        if (mySession) {
            mySession.status = "stopped";
            this.updateSessionContext();
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
            this.updateSessionContext();
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
        const mySession = CDebugSession.GetSession(e.session);
        handleRTTConfigureEvent(e.body, mySession, (decoder: RTTConsoleDecoderOpts, src: SocketRTTSource) => {
            const newTerminal = new IOTerminal(decoder, src);
            if (vscode.debug.activeDebugConsole) {
                vscode.debug.activeDebugConsole.appendLine(`Created RTT terminal for channel ${decoder.port} on tcp port ${decoder.tcpPort}`);
            }
        });
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

    private toggleLiveWatchBatchEdit() {
        this.liveWatchWebview.toggleBatchMode();
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

    private ensureWrapperScripts(extensionPath: string) {
        const binDir = path.join(os.homedir(), ".mcu-debug", "bin");
        try {
            mkdirSync(binDir, { recursive: true });

            const serverExePath = getHelperExecutable(extensionPath);
            if (!existsSync(serverExePath)) {
                MCUDebugChannel.debugMessage(`Wrapper script creation failed. Missing mdbg executable at ${serverExePath}`);
                return;
            }
            const fSlashPath = serverExePath.replace(/\\/g, "/");

            // macOS & Linux wrapper
            const bashWrapperPath = path.join(binDir, "mcu-debug");
            const bashContent = `#!/usr/bin/env bash
exec "${fSlashPath}" "\$@"
`;

            // Windows wrapper
            const winWrapperPath = path.join(binDir, "mcu-debug.cmd");
            const windowsExtPath = path.normalize(fSlashPath);
            const winContent = `@"${windowsExtPath}" %*
`;

            this.writeIfDifferent(bashWrapperPath, bashContent, true);
            this.writeIfDifferent(winWrapperPath, winContent, false);
        } catch (error) {
            MCUDebugChannel.debugMessage(`Failed to create wrapper scripts directory: ${error}`);
        }
    }

    private writeIfDifferent(filePath: string, content: string, setExecutable: boolean) {
        let shouldWrite = true;
        if (existsSync(filePath)) {
            try {
                const existing = readFileSync(filePath, "utf8");
                if (existing === content) {
                    shouldWrite = false;
                }
            } catch { }
        }
        if (shouldWrite) {
            try {
                writeFileSync(filePath, content, { mode: setExecutable ? 0o755 : undefined });
            } catch (error) {
                MCUDebugChannel.debugMessage(`Failed to write wrapper script ${filePath}: ${error}`);
            }
        }
    }

    private isBinDirInPath(): boolean {
        const binDir = path.resolve(os.homedir(), ".mcu-debug", "bin").toLowerCase();
        const paths = (process.env.PATH || "").split(path.delimiter);
        for (const p of paths) {
            try {
                if (path.resolve(p).toLowerCase() === binDir) {
                    return true;
                }
            } catch { }
        }
        return false;
    }

    private depositProvision(data: ProvisioningResults) {
        const toLower = (s: string) => {
            if (os.platform() === "win32") {
                return s.toLowerCase();
            }
            return s;
        }
        const platPath = toLower(data?.resultsFile || "");
        if (!platPath || !platPath.startsWith(toLower(os.tmpdir()))) {
            MCUDebugChannel.debugMessage(`Error: resultsFile must be in the temporary directory. Provisioning results deposited at: ${data.resultsFile}`);
            return
        }
        try {
            fs.writeFileSync(data.resultsFile, JSON.stringify(data), { encoding: "utf8" });
            MCUDebugChannel.debugMessage(`Provisioning results deposited at: ${data.resultsFile}`);
        } catch (error) {
            MCUDebugChannel.debugMessage(`Error writing provisioning results to file: ${error}`);
        }
    }
}

function logTmp(msg: string) {
    const tmpFile = os.tmpdir() + "/mcu-debug-uri.log";
    const currentTime = new Date().toLocaleString();
    fs.appendFileSync(tmpFile, currentTime + ": " + msg + "\n");
}

class MyUriHandler implements vscode.UriHandler {
    constructor(private context: vscode.ExtensionContext) {
        // Nothing to do in the constructor for now
    }
    // This function will get run when something redirects to VS Code
    // with your extension id as the authority.
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        // vscode.window.showInformationMessage(`[mcu-debug] handleUri called with URI: ${uri.toString()}`);
        logTmp(`[mcu-debug] handleUri called with URI: ${uri.toString()}`);
        if ((uri.path === "/provision") && uri.query) {
            // The request is one JSON param (`req`) so every field keeps its real
            // type — `v` is a number, `args` is an array. (URLSearchParams would
            // otherwise String()-coerce everything to strings / "[object Object]".)
            // A `const` (via IIFE) so the narrowing below survives into the async
            // `.then()` closures where `obj` is used.
            const obj: ProxyProvisionRequest | undefined = (() => {
                const raw = new URLSearchParams(uri.query).get("req");
                if (!raw) {
                    return undefined;
                }
                try {
                    return JSON.parse(raw) as ProxyProvisionRequest;
                } catch {
                    return undefined; // malformed JSON → treat as no valid request
                }
            })();
            logTmp(`[mcu-debug] handleUri parsed request: ${JSON.stringify(obj)}`);
            if (obj && obj.v === 1 && obj.api && obj.resultsFile) {
                let error = "";
                const cmd = `mcu-debug-proxy.${obj.api}`;
                try {
                    const args = obj.args || [];
                    vscode.commands.executeCommand(cmd, ...args).then((res) => {
                        if (res) {
                            this.depositProvision(obj, "", res);
                        } else {
                            this.depositProvision(obj, `No result returned from command: ${cmd}`, undefined);
                        }
                    })
                } catch (e) {
                    this.depositProvision(obj, cmd + ': Error: ' + (e ? e.toString() : "unknown error"), undefined);
                }
            }
        }
    }

    private depositProvision(obj: ProxyProvisionRequest, error: string, result: any) {
        const results: ProvisioningResults = {
            resultsFile: obj.resultsFile,
            error: error,
            result: result,
        };
        logTmp(`[mcu-debug] handleUri parsed request: ${JSON.stringify(obj)}`);
        vscode.commands.executeCommand("mcu-debug.depositProvision", results).then((reason) => {
            logTmp(`[mcu-debug] depositProvision completed: ${reason}`);
        });
    }

    public validateAuthority(authority: string): Promise<boolean> {
        return new Promise<boolean>(async (resolve) => {
            let resolved = false;
            let permissions = this.context.globalState.get<string[]>("mcu-debug-proxy.authorizedAuthorities", []);
            if (permissions.includes(authority)) {
                return resolve(true);
            }
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    return resolve(false);
                }
            }, 30_000); // 30 seconds timeout for user to respond
            const choices = ["Deny", "Allow", "Always Allow"];
            const result = await vscode.window.showWarningMessage(
                `The authority "${authority}" is requesting access to the MCU Debug Proxy. Do you want to allow it?`,
                { modal: true },
                ...choices
            );

            if (result === choices[1] || result === choices[2]) {
                if (result === choices[2]) {
                    permissions.push(authority);
                    this.context.globalState.update("mcu-debug-proxy.authorizedAuthorities", permissions);
                }
                if (!resolved) {
                    clearTimeout(timer);
                    resolved = true;
                    return resolve(true);
                }
            }
            if (!resolved) {
                clearTimeout(timer);
                resolved = true;
                return resolve(false);
            }
        });
    }
    private async applyLegacyMcpSetting(): Promise<void> {
        const config = vscode.workspace.getConfiguration("mcu-ai-debug");
        if (!config.get<boolean>("enableMcp", false)) {
            this.liveWatchMcpServer.dispose();
            return;
        }
        if (this.liveWatchMcpServer.getPort() !== null) {
            return;
        }
        try {
            await this.liveWatchMcpServer.start(
                config.get<number>("mcpPreferredPort", 51234),
                config.get<number>("mcpPortSearchRange", 100),
            );
            await this.refreshWorkspaceMcpPortFile(false);
        } catch (err: any) {
            vscode.window.showWarningMessage(`Legacy MCP server did not start: ${err?.message ?? String(err)}`);
        }
    }

    private getMcpPortFilePath(vscodeDir: string): string {
        return path.join(vscodeDir, "mcu-debug-mcp-port.json");
    }

    private async refreshWorkspaceMcpPortFile(createDirectory: boolean): Promise<string | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }

        const vscodeDir = path.join(workspaceFolder.uri.fsPath, ".vscode");
        return this.writeMcpPortFile(vscodeDir, createDirectory);
    }

    private async writeMcpPortFile(vscodeDir: string, createDirectory: boolean): Promise<string | null> {
        const port = this.liveWatchMcpServer.getPort();
        if (!port) {
            return null;
        }

        const vscodeDirUri = vscode.Uri.file(vscodeDir);
        if (createDirectory) {
            await vscode.workspace.fs.createDirectory(vscodeDirUri);
        } else {
            try {
                await vscode.workspace.fs.stat(vscodeDirUri);
            } catch (_e) {
                return null;
            }
        }

        const portFilePath = this.getMcpPortFilePath(vscodeDir);
        const portFile = {
            host: "127.0.0.1",
            port,
            updatedAt: new Date().toISOString(),
            pid: process.pid,
            extensionPath: this.context.extensionPath,
        };
        await vscode.workspace.fs.writeFile(vscode.Uri.file(portFilePath), Buffer.from(JSON.stringify(portFile, null, 2) + "\n", "utf8"));
        return portFilePath;
    }

    private async generateMcpConfig() {
        if (!vscode.workspace.getConfiguration("mcu-ai-debug").get<boolean>("enableMcp", false) || !this.liveWatchMcpServer.getPort()) {
            vscode.window.showInformationMessage("Legacy MCP is disabled. Enable mcu-ai-debug.enableMcp in Settings first.");
            return;
        }
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
            const fallbackJson = JSON.stringify(this.buildGenericConfig(nodeCmd, bridgePath, { port: this.liveWatchMcpServer.getPort() ?? 51234 }), null, 2);
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
            const portFilePath = await this.writeMcpPortFile(vscodeDir, true);

            if (choice.id === "vscode") {
                // VS Code native format: .vscode/mcp.json
                const vscodeMcpPath = path.join(vscodeDir, "mcp.json");
                const bridgeArgs = this.buildMcpBridgeArgs(bridgePath, { portFile: portFilePath ?? undefined, port: this.liveWatchMcpServer.getPort() ?? 51234 });
                const vscodeConfig = {
                    servers: {
                        "mcu-debug": {
                            type: "stdio",
                            command: nodeCmd,
                            args: bridgeArgs,
                            env: {
                                ELECTRON_RUN_AS_NODE: "1",
                                MCU_DEBUG_MCP_PORT: String(this.liveWatchMcpServer.getPort() ?? 51234),
                                ...(portFilePath ? { MCU_DEBUG_MCP_PORT_FILE: portFilePath } : {})
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
                const genericConfig = this.buildGenericConfig(nodeCmd, bridgePath, { portFile: portFilePath ?? undefined, port: this.liveWatchMcpServer.getPort() ?? 51234 });
                const content = `// Deprecated MCP compatibility configuration, generated by MCU-AI-Debug\n// Copy this into your AI agent's MCP configuration if you still use the legacy bridge.\n// See .vscode/mcu-debug-mcp.md for details.\n\n${JSON.stringify(genericConfig, null, 2)}\n`;
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

    private buildMcpBridgeArgs(bridgePath: string, endpoint: { portFile?: string; port: number }): string[] {
        if (endpoint.portFile) {
            return [bridgePath, "--port-file", endpoint.portFile];
        }
        return [bridgePath, "--port", String(endpoint.port)];
    }

    private buildGenericConfig(nodeCmd: string, bridgePath: string, endpoint: { portFile?: string; port: number }) {
        return {
            mcpServers: {
                "mcu-debug": {
                    command: nodeCmd,
                    args: this.buildMcpBridgeArgs(bridgePath, endpoint),
                    env: {
                        ELECTRON_RUN_AS_NODE: "1",
                        MCU_DEBUG_MCP_PORT: String(endpoint.port),
                        ...(endpoint.portFile ? { MCU_DEBUG_MCP_PORT_FILE: endpoint.portFile } : {})
                    }
                }
            }
        };
    }

    private async generateMcpDoc(vscodeDir: string) {
        const docPath = path.join(vscodeDir, "mcu-debug-mcp.md");
        const docStr = [
            "# MCU-Debug MCP Tool Reference (Deprecated)",
            "",
            "> This legacy integration is opt-in. The mcu-debug CLI is the supported AI interface; use these tools only when `mcu-ai-debug.enableMcp` is enabled.",
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
            "- The maximum wall-clock time is controlled by the user's `mcu-ai-debug.mcpManualRecordingMaxDuration` setting (default: 60s).",
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
            "The generated MCP configuration points the bridge at `.vscode/mcu-debug-mcp-port.json`. MCU-Debug rewrites this file with the actual localhost port used by the current VS Code window, so multiple VS Code instances can avoid port collisions.",
            "",
            "## VS Code Settings Reference",
            "",
            "| Setting | Type | Default | Description |",
            "|---|---|---|---|",
            "| `mcu-ai-debug.enableMcp` | boolean | false | Enable the deprecated MCP bridge. |",
            "| `mcu-ai-debug.mcpRequireManualRecording` | boolean | false | If enabled, `record_livewatch_variables` returns `MANUAL_MODE_REQUIRED` and agents must use the manual tool. |",
            "| `mcu-ai-debug.mcpRecordingMaxDuration` | number | 30 | Max recording duration in seconds for automatic mode. |",
            "| `mcu-ai-debug.mcpManualRecordingMaxDuration` | number | 60 | Max recording duration in seconds for manual mode. |",
            "| `mcu-ai-debug.mcpPreferredPort` | number | 51234 | Preferred localhost port for the MCP server. |",
            "| `mcu-ai-debug.mcpPortSearchRange` | number | 100 | Number of consecutive ports to try when the preferred MCP port is busy. |",
            "",
        ].join("\n");
        await vscode.workspace.fs.writeFile(vscode.Uri.file(docPath), Buffer.from(docStr, "utf8"));
    }
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        console.log("[mcu-debug] Activating mcu-debug extension");
        if (context.extensionMode === vscode.ExtensionMode.Development) {
            console.log("[mcu-debug] Running in development mode");
            setDevelopmentModeEnvVars();
        }
        setHostAdapter(new VscodeAdapter(context));
        Reporting.activateTelemetry(context);
        MCUDebugChannel.createDebugChannel();
        logger.add(new VscodeOutputChannelTransport(MCUDebugChannel.outputChannel, { level: 'debug' }));

        // Nudge the user to install the companion proxy extension before anything depends on
        // it -- the failure this avoids is discovering it is missing at the moment F5 is
        // pressed. Fire-and-forget so activation is never held up by a dialog; it remembers a
        // "Don't Ask Again" and stays quiet once the proxy answers.
        promptProxyInstallOnce(context).catch((err) => {
            logger.error(`MCU-Debug Proxy install prompt failed: ${err}`);
        });

        const packageJson = context.extension.packageJSON;
        const version = packageJson.version || "unknown";
        MCUDebugChannel.debugMessage(`Starting mcu-debug extension. Version = ${version}, Path = ${context.extensionPath}, PID=${process.pid}`);
        let wsType = vscode.env.remoteName ?? "local";
        if (wsType === "wsl") {
            wsType += '-' + getWSLNetworkingMode();
        }
        MCUDebugChannel.debugMessage(`Workspace location type: ${wsType}`);
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            MCUDebugChannel.debugMessage(`Extension startup workspace: ${vscode.workspace.name}, folders:\n  ${vscode.workspace.workspaceFolders?.map((f) => f.name).join(",\n  ")}`);
            MCUDebugChannel.debugMessage(`Workspace URI:\n  ${vscode.workspace.workspaceFolders?.map((f) => f.uri.toString()).join(",\n  ")}`);
        } else {
            MCUDebugChannel.debugMessage("Extension startup: No workspace");
        }
    } catch (_e) {
        /* empty */
    }

    const ret = new MCUDebugExtension(context);
    try {
        await ret.initialize();
    } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage(`mcu-debug: Extension initialization failed. Some features may not work. Error: ${e}`);
    }
    return ret;
}

export async function deactivate() {
    SerialPortManager.Dispose();
}
