const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const cp = require("node:child_process");
const vscode = require("vscode");
const base = process.env.MCU_AI_SMOKE_BASE || "/tmp/mcu-ai-session-smoke";
const instance = process.env.MCU_SMOKE_INSTANCE;
const other = instance === "A" ? "B" : "A";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 45000) {
    const end = Date.now() + timeout;
    while (!fn()) {
        if (Date.now() > end) throw new Error("Timeout: " + fn);
        await sleep(25);
    }
}
exports.run = async () => {
    const extension = vscode.extensions.getExtension("Runzelee.mcu-ai-debug");
    const api = await extension.activate();
    await vscode.workspace.getConfiguration("mcu-ai-debug").update("cockpit.sessionMode", "current", vscode.ConfigurationTarget.Global);
    const commands = await vscode.commands.getCommands(true);
    assert(commands.includes("mcu-ai-debug.selectSession"));
    assert(commands.includes("mcu-ai-debug.disconnectSession"));
    assert.equal(api.liveWatchMcpServer.getPort(), null);
    if (process.env.MCU_AI_VISUAL_PORT) {
        await require("./live-watch-sidebar.smoke.cjs").run({vscode,base,port:process.env.MCU_AI_VISUAL_PORT});
    }
    const calls = [];
    let config;
    let adapter;
    class FakeAdapter {
        constructor() {
            this.emitter = new vscode.EventEmitter();
            this.onDidSendMessage = this.emitter.event;
            this.seq = 1;
        }
        send(message) {
            this.emitter.fire({ seq: this.seq++, ...message });
        }
        event(event, body) {
            this.send({ type: "event", event, body });
        }
        handleMessage(request) {
            calls.push(request);
            let body = {};
            if (request.command === "initialize") body = { supportsConfigurationDoneRequest: true };
            if (request.command === "attach" || request.command === "launch") config = request.arguments;
            if (request.command === "get-arguments") body = config;
            if (request.command === "threads") body = { threads: [{ id: 1, name: "Mock MCU" }] };
            if (request.command === "stackTrace") body = { stackFrames: [], totalFrames: 0 };
            if (request.command === "scopes") body = { scopes: [] };
            if (request.command === "variables") body = { variables: [] };
            if (request.command === "evaluate") {
                body = { result: "", variablesReference: 0 };
                this.event("output", {
                    category: "console",
                    output: `mock-gdb-${instance}: ${request.arguments.expression}\n`,
                });
            }
            this.send({ type: "response", request_seq: request.seq, command: request.command, success: true, body });
            if (request.command === "attach" || request.command === "launch") this.event("initialized");
            if (request.command === "configurationDone" || request.command === "pause") this.event("stopped", { reason: "pause", threadId: 1, allThreadsStopped: true });
            if (request.command === "continue") this.event("continued", { threadId: 1, allThreadsContinued: true });
            if (request.command === "disconnect" || request.command === "terminate") this.event("terminated");
        }
        dispose() {
            this.emitter.dispose();
        }
    }
    const factory = vscode.debug.registerDebugAdapterDescriptorFactory("mcu-debug", {
        createDebugAdapterDescriptor() {
            adapter = new FakeAdapter();
            return new vscode.DebugAdapterInlineImplementation(adapter);
        },
    });
    const folder = vscode.workspace.workspaceFolders[0];
    const launched = await vscode.debug.startDebugging(folder, {
        name: "STM32 Debug",
        type: "mcu-debug",
        request: "attach",
        servertype: "external",
        gdbTarget: "localhost:3333",
        cwd: folder.uri.fsPath,
        executable: process.env.MCU_AI_SMOKE_ELF || "/bin/true",
        liveWatch: { enabled: false },
        rttConfig: { enabled: false },
    });
    assert.equal(launched, true);
    await until(() => api.sessionBridge.bindings.size === 1);
    const binding = [...api.sessionBridge.bindings.values()][0];
    const cockpit = [...api.cockpitPanel._tabs.values()].find((tab) => tab.kind === "cockpit");
    await until(() => cockpit.attachedRecord?.id === binding.socket.record.id);
    assert.equal(cockpit.process, null, "F5 must automatically attach Cockpit without an independent driver");
    await until(() => fs.existsSync(`${process.env.HOME}/.mcu-ai-debug/sessions/${binding.socket.record.id}.json`));
    fs.writeFileSync(`${base}/ready-${instance}.json`, JSON.stringify(binding.socket.record));
    await until(() => fs.existsSync(`${base}/ready-${other}.json`));
    const entry = extension.extensionPath + "/dist/mcu-ai-debug-cli.js";
    const list = JSON.parse(cp.execFileSync("node", [entry, "sessions", "--json"], { encoding: "utf8" }));
    const peers = list.filter((record) => record.cwd === folder.uri.fsPath);
    assert.equal(peers.length, 2, "two real VS Code instances must be discoverable");
    assert.notEqual(peers[0].windowId, peers[1].windowId);
    const ambiguous = cp.spawnSync("node", [entry, "attach"], { cwd: folder.uri.fsPath, encoding: "utf8" });
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /Multiple sessions/);
    const child = cp.spawn("node", [entry, "attach", "--session", binding.socket.record.id], {
        cwd: folder.uri.fsPath,
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    let errors = "";
    child.stderr.on("data", (data) => (errors += data.toString()));
    child.stdin.write("status\np counter\n!!SIGINT\ncontinue\n");
    await until(() => output.includes(`mock-gdb-${instance}: p counter`) && calls.some((call) => call.command === "continue"));
    assert(calls.some((call) => call.command === "evaluate" && call.arguments.context === "repl" && call.arguments.expression === "p counter"));
    assert(calls.some((call) => call.command === "pause"));
    assert(!output.includes(`mock-gdb-${other}`), "commands/output must stay bound to selected session");
    // Feed the actual shared RTT source from a local fake RTT server, not hardware.
    let rttConnection,
        rttReceived = "";
    const rttServer = net.createServer((connection) => {
        rttConnection = connection;
        connection.on("data", (data) => (rttReceived += data.toString()));
    });
    await new Promise((resolve) => rttServer.listen(0, "127.0.0.1", resolve));
    adapter.event("rtt-configure", {
        type: "socket",
        decoder: {
            port: 0,
            tcpPort: String(rttServer.address().port),
            type: "console",
            label: "buzzer_debug",
            encoding: "utf8",
        },
    });
    await until(() => rttConnection);
    rttConnection.write('buzzer_debug={"value":17}\n');
    await until(() =>
        output.split("\n").some((line) => {
            try {
                const event = JSON.parse(line);
                return event.source === "RTT" && event.message.includes('buzzer_debug={"value":17}');
            } catch {
                return false;
            }
        }),
    );
    child.stdin.write("!!send [RTT#0]   go  \n");
    await until(() => rttReceived === "  go  \r\n");
    assert.equal(calls.filter((call) => call.command === "rtt-poll").length, 1, "AI must not create another RTT poller");
    await require("./rtt-watch.smoke.cjs").run({vscode,api,rttConnection,calls,base,instance,sessionId:binding.session.id});
    // Reuse the real serial view/manager and its TCP bridge, without physical hardware.
    let uartConnection, uartReceived = "", uartConnections = 0;
    const uartServer = net.createServer(connection => {
        uartConnection = connection; uartConnections++;
        connection.on("data", data => uartReceived += data.toString());
    });
    await new Promise(resolve => uartServer.listen(0, "127.0.0.1", resolve));
    const uartDevice = `/dev/mockUART-${instance}`, uartOwner = `uart-owner-${instance}`;
    let uartOpens = 0;
    const uartProxy = { key: `uart-proxy-${instance}`, label: "Local UART bridge", closePort() {}, dispose() {},
        getCurrentSerialPorts: () => [{path:uartDevice,description:"Mock USB UART",vid:0x0483,pid:0x5740,serial:`uart-${instance}`}],
        async openSerialPort(params) {
            assert.equal(params.path,uartDevice); assert.equal(params.baud_rate,115200); uartOpens++;
            return {path:uartDevice,tcp_port:uartServer.address().port};
        }
    };
    api.serialPortManager.connections.set(uartProxy.key,uartProxy);
    const uartPrepare=api.serialPortManager.prepareSerialPorts,uartPick=vscode.window.showQuickPick,uartInput=vscode.window.showInputBox;
    api.serialPortManager.prepareSerialPorts=async()=>{};
    vscode.window.showQuickPick=async items=>items.find(item=>item.source?.port.path===uartDevice);
    vscode.window.showInputBox=async options=>{assert.equal(options.title,"UART Baud Rate");return "115200";};
    try{await vscode.commands.executeCommand("mcu-debug.cockpit.addUart");}finally{
        api.serialPortManager.prepareSerialPorts=uartPrepare;vscode.window.showQuickPick=uartPick;vscode.window.showInputBox=uartInput;
    }
    assert.equal(uartOpens,1,"Add UART must open exactly one selected port");
    const uartView = api.serialPortManager.getSerialPortTab(uartDevice);
    assert(uartView);
    uartView.streamPrefix="[UART]";
    uartView.setLabel("UART");
    uartView.constructor.bindSession(binding.session.id, uartOwner);
    await until(() => uartConnection);
    uartConnection.write('buzzer_debug={"frequency_hz":9600,"enabled":true}\r\n');
    await until(() => output.split("\n").some(line => {
        try { const event=JSON.parse(line); return event.source === "serial" && event.port === uartDevice && event.message.includes('"frequency_hz":9600'); } catch { return false; }
    }));
    await until(() => api.rttWatchProvider.store.leaves.some(n => n.scalar === 9600));
    assert(api.rttWatchProvider.store.leaves.some(n => n.scalar === 4027), "UART must not replace RTT's same-named snapshot");
    child.stdin.write("!!send [UART]   shared-uart  \n");
    await until(() => uartReceived === "  shared-uart  \r\n");
    assert.equal(uartConnections, 1, "JSON Watch and CLI share the IDE UART connection");
    const jsonBefore = calls.length, oldJsonPick = vscode.window.showQuickPick, oldJsonSave = vscode.window.showSaveDialog;
    let jsonDestination;
    try {
        vscode.window.showQuickPick = async items => items;
        vscode.window.showSaveDialog = async () => vscode.Uri.file(jsonDestination);
        jsonDestination = `${base}/json-uart-snapshot-${instance}.json`;
        await api.rttWatchProvider.saveSnapshot();
        const snapshot = JSON.parse(fs.readFileSync(jsonDestination, "utf8"));
        assert.equal(snapshot.format, "mcu-ai-debug.json-watch.v1");
        assert(snapshot.sources.some(source => source.transport === "UART" && source.port === uartDevice));
        assert(snapshot.sources.some(source => source.transport === "RTT" && source.channel === 0));
        jsonDestination = `${base}/json-uart-recording-${instance}.jsonl`;
        await api.rttWatchProvider.startRecording();
        rttConnection.write('buzzer_debug={"frequency_hz":4300}\n');
        uartConnection.write('buzzer_debug={"frequency_hz":9700}\n');
        await until(() => api.rttWatchProvider.store.leaves.some(n => n.scalar === 9700));
        await api.rttWatchProvider.stopRecording();
        const rows = fs.readFileSync(jsonDestination,"utf8").trim().split("\n").map(JSON.parse);
        assert.equal(rows.length, 2);
        assert.deepEqual(new Set(rows.map(row => row.source.transport)), new Set(["RTT", "UART"]));
        jsonDestination = `${base}/json-uart-disconnect-${instance}.jsonl`;
        await api.rttWatchProvider.startRecording();
        const uartRecording = api.rttWatchProvider.recording;
        const uartFinished = new Promise((resolve,reject) => {uartRecording.stream.once("finish",resolve);uartRecording.stream.once("error",reject);});
        const uartRoot = api.rttWatchProvider.store.roots.find(n => api.rttWatchProvider.store.source(n.id).port === uartDevice);
        uartView.notifyDisconnected("smoke reconnect");
        await uartFinished;
        assert.equal(api.rttWatchProvider.store.isActive(uartRoot.id), false);
        assert.equal(api.rttWatchProvider.recording, undefined);
        uartView.setTcpPort(uartServer.address().port);
        await until(() => uartConnections === 2);
        uartConnection.write('buzzer_debug={"frequency_hz":9800}\n');
        await until(() => api.rttWatchProvider.store.leaves.some(n => n.scalar === 9800));
        assert.equal(api.rttWatchProvider.store.isActive(uartRoot.id), true);
        assert.equal(calls.length, jsonBefore, "JSON Watch must not read GDB");
    } finally { vscode.window.showQuickPick = oldJsonPick; vscode.window.showSaveDialog = oldJsonSave; }
    // GDB server diagnostics are mirrored through the same DAP tracker.
    adapter.event("custom-event-ai-server-output", { info: { message: "mock-openocd-" + instance } });
    await until(() => output.includes("mock-openocd-" + instance));
    // Cached panel reads do not cause another DAP request or auto-expand a struct.
    const provider = api.liveWatchProvider;
    provider.resetSession(binding.session);
    const node = provider.rootNode.addChild("counter", "counter", "17", "int", 0);
    const before = calls.length;
    const snapshot = provider.getCachedPanelSnapshot(binding.session.id);
    assert.equal(snapshot.variables.counter.value, "17");
    assert.equal(calls.length, before);
    assert.throws(() => provider.getCachedPanelSnapshot("other-session"), /another session/);
    child.stdin.write('!!livewatch read\n!!livewatch add {"expression":"unauthorized"}\n');
    await until(() => output.includes('"sampledAt"') && output.includes("explicit user request"));
    assert(!provider.rootNode.getChildren().some((node) => node.getExpr() === "unauthorized"));
    child.stdin.write('!!livewatch add {"expression":"requested","userRequested":true}\n');
    await until(() => provider.rootNode.getChildren().some((node) => node.getExpr() === "requested"));
    child.stdin.write('!!livewatch remove {"expression":"requested","userRequested":true}\n');
    await until(() => !provider.rootNode.getChildren().some((node) => node.getExpr() === "requested"));
    // Pure CLI human loop: no Live Watch sampling/listeners and no MCP server.
    const manual = api.sessionBridge.manual,
        prompts = [];
    const originalPrompt = manual.prompt;
    const debugStateBeforeManual = cockpit.sessionState;
    if (process.env.MCU_AI_VISUAL_PORT) {
        await require("./cockpit-visual.smoke.cjs").run({ vscode, entry, ownerId: binding.socket.record.id, cockpit, panel: api.cockpitPanel, uartView, uartConnection, base, port: process.env.MCU_AI_VISUAL_PORT });
        await require("./rtt-watch-visual.smoke.cjs").run({vscode,api,rttConnection,uartConnection,base,port:process.env.MCU_AI_VISUAL_PORT});
    }
    let stop;
    manual.prompt = async (_name, button) => {
        prompts.push(button);
        if (button === "Start") return true;
        return new Promise((resolve) => {
            stop = () => resolve(true);
        });
    };
    const runManualCommand = (action) =>
        new Promise((resolve, reject) => {
            const request = cp.spawn("node", [entry, "manual", action, "--session", binding.socket.record.id]);
            let response = "";
            request.stdout.on("data", (chunk) => (response += chunk));
            request.once("error", reject);
            request.once("close", (code) => {
                try {
                    resolve({ code, response: JSON.parse(response.trim()) });
                } catch (error) {
                    reject(error);
                }
            });
        });
    // The panel deliberately has no session: manual must still work.
    const panelSession = provider.constructor.session;
    provider.constructor.session = undefined;
    const watchBefore = provider.mcpListeners.length,
        callsBefore = calls.length;
    const started = await runManualCommand("start");
    assert.equal(started.code, 0);
    assert.equal(started.response.state, "active");
    assert.equal(cockpit.sessionState, debugStateBeforeManual, "manual state must not overwrite MCU debug controls");
    assert.deepEqual(prompts, ["Start", "Stop"]);
    assert.equal(provider.mcpListeners.length, watchBefore);
    assert.equal(calls.length, callsBefore, "manual UI must not query GDB or panel values");
    assert.equal((await runManualCommand("status")).response.state, "active");
    const waiting = runManualCommand("wait");
    child.stdin.write("p manual_counter\n!!send [RTT#0] manual-input\n");
    await until(() => output.includes(`mock-gdb-${instance}: p manual_counter`) && rttReceived.endsWith("manual-input\r\n"));
    rttConnection.write("manual-rtt-data\n");
    await until(() => output.includes("manual-rtt-data"));
    stop();
    const ended = await waiting;
    assert.equal(ended.code, 0);
    assert.equal(ended.response.status, "USER_STOPPED");
    await until(() => output.includes('"event":"manual-state"') && output.includes('"status":"USER_STOPPED"'));
    assert.equal(provider.mcpListeners.length, watchBefore);
    assert.equal(api.liveWatchMcpServer.getPort(), null);
    manual.prompt = async () => false;
    const cancelled = await runManualCommand("start");
    assert.equal(cancelled.code, 2);
    assert.equal(cancelled.response.status, "CANCELLED_BY_USER");
    // Interactive manual CLI gates input until Start and disconnects on the user's Stop.
    let approve;
    manual.prompt = async (_name, button) =>
        new Promise((resolve) => {
            if (button === "Start") approve = () => resolve(true);
            else stop = () => resolve(true);
        });
    const interactive = cp.spawn("node", [entry, "manual", "--session", binding.socket.record.id]);
    let interactiveOutput = "";
    interactive.stdout.on("data", (chunk) => (interactiveOutput += chunk));
    interactive.stdin.write("p gated_manual_counter\n!!send [UART] manual-uart\n");
    interactive.stdin.end(); // EOF must not end the RTT stream before the human's Stop.
    await until(() => approve);
    await sleep(40);
    assert(!calls.some((call) => call.arguments?.expression === "p gated_manual_counter"));
    assert(!interactiveOutput.includes("mock-gdb"), "manual must not replay GDB/RTT before Start approval");
    assert(!uartReceived.includes("manual-uart"), "UART writes must wait for Start approval");
    approve();
    await until(() => uartReceived.includes("manual-uart\r\n"));
    uartConnection.write('manual={"uart":true}\n');
    await until(() => interactiveOutput.split("\n").some(line => {
        try { const event = JSON.parse(line); return event.source === "serial" && event.message.includes('manual={"uart":true}'); } catch { return false; }
    }));
    await until(() => interactiveOutput.includes(`mock-gdb-${instance}: p gated_manual_counter`));
    const interactiveClosed = new Promise((resolve) => interactive.once("close", resolve));
    stop();
    assert.equal(await interactiveClosed, 0);
    assert(interactiveOutput.includes('"status":"USER_STOPPED"'));
    assert(api.sessionBridge.bindings.has(binding.session.id));
    provider.constructor.session = panelSession;
    manual.prompt = originalPrompt;
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(errors, "");
    assert(api.sessionBridge.bindings.has(binding.session.id), "AI disconnect must leave F5 alive");
    // Cockpit current mode connects to the same socket without starting another CLI/GDB.
    let spawnCount = 0;
    const originalSpawn = cp.spawn;
    cp.spawn = function (...args) {
        if (args[1]?.[0]?.endsWith("/dist/mcu-debug-cli.js")) {
            spawnCount++;
            throw new Error("Shared F5 mode attempted to start an independent driver");
        }
        return originalSpawn.apply(this, args);
    };
    await vscode.commands.executeCommand("mcu-debug.cockpit.startDebugSession");
    await sleep(120);
    assert.equal(spawnCount, 0);
    cp.spawn = originalSpawn;
    await vscode.commands.executeCommand("mcu-ai-debug.disconnectSession");
    assert(api.sessionBridge.bindings.has(binding.session.id));
    // Independent mode still prepares and launches the upstream CLI, with a VS Code manual UI host.
    await cockpit.onCockpitModeSelect("independent");
    assert.equal(cockpit.attachedSocket, undefined);
    assert(api.sessionBridge.bindings.has(binding.session.id), "mode switch must not stop F5");
    const { EventEmitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    let independent;
    cp.spawn = (program, args, options) => {
        assert.equal(program, "node");
        assert(args[0].endsWith("/dist/mcu-debug-cli.js"));
        const configFile = args[args.indexOf("--json") + 1];
        independent = { config: JSON.parse(fs.readFileSync(configFile, "utf8")).configurations[0], options };
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        independent.child = child;
        queueMicrotask(() => child.emit("spawn"));
        return child;
    };
    await sleep(30);
    await vscode.commands.executeCommand("mcu-debug.cockpit.startDebugSession", "Independent smoke");
    assert(independent, "independent mode must start the CLI driver");
    assert.equal(independent.config.cwd, folder.uri.fsPath);
    assert(independent.options.env.MCU_AI_DEBUG_UI_SOCKET, "independent mode must retain a manual UI host");
    cp.spawn = originalSpawn;
    // Passive structured reads from the independent driver's stdout, no extra connection.
    cockpit.independentRtt.channels = [{channel:2,prefix:"[independent-json]",timestamp:true}];
    independent.child.stdout.write('[independent-json] [2026-10-02T12:34:56.789] motor={"rpm":1234}\n');
    await until(()=>api.rttWatchProvider.store.leaves.some(n=>n.watch==="motor"&&n.scalar===1234));
    cockpit.independentRtt.channels.push({channel:0,port:"/dev/independent-uart",prefix:"[independent-UART]",timestamp:false});
    independent.child.stdout.write('[independent-UART] motor={"rpm":2345}\n');
    await until(()=>api.rttWatchProvider.store.leaves.some(n=>n.watch==="motor"&&n.scalar===2345));
    const independentRoot=api.rttWatchProvider.store.roots.find(n=>api.rttWatchProvider.store.source(n.id).channel===2);
    assert(independentRoot);
    independent.child.emit("close", 0);
    assert.equal(api.rttWatchProvider.store.isActive(independentRoot.id),false);

    await cockpit.onCockpitModeSelect("current");
    await until(() => cockpit.attachedRecord?.id === binding.socket.record.id);
    fs.writeFileSync(
        `${base}/checked-${instance}.json`,
        JSON.stringify({
            instance,
            version: extension.packageJSON.version,
            session: binding.socket.record.id,
            checks: [
                "two-vscode-instances",
                "ambiguous-selection",
                "shared-gdb-dispatch",
                "shared-rtt-source-and-send",
                "shared-uart-source-and-send",
                "add-uart-command-device-picker-open",
                "standalone-uart-json-without-debug-session",
                "json-watch-mixed-uart-rtt-snapshot-recording",
                "manual-uart-gated-until-start",
                "independent-cockpit-uart-json",
                "rtt-watch-tree-typed-snapshot-jsonl-csv-graph",
                "independent-cockpit-rtt-watch-passive-stdout",
                "cached-livewatch",
                "explicit-panel-mutations",
                "cli-manual-no-livewatch-no-mcp",
                "manual-input-gated-until-start-and-ends-on-user-stop",
                "cockpit-auto-follows-f5",
                "cockpit-visible-mode-callback",
                "independent-cockpit-start-path",
                "disconnect-preserves-f5",
            ],
            hardware: false,
        }),
    );
    await until(() => fs.existsSync(`${base}/checked-${other}.json`));
    const oldPick=vscode.window.showQuickPick,oldSave=vscode.window.showSaveDialog;
    const disconnectFile=`${base}/rtt-disconnect-${instance}.jsonl`;
    vscode.window.showQuickPick=async items=>items;
    vscode.window.showSaveDialog=async()=>vscode.Uri.file(disconnectFile);
    try{await api.rttWatchProvider.startRecording();}finally{vscode.window.showQuickPick=oldPick;vscode.window.showSaveDialog=oldSave;}
    const disconnectRecording=api.rttWatchProvider.recording;
    assert(disconnectRecording);
    rttConnection.write('buzzer_debug={"frequency_hz":9999}\n');
    await until(()=>api.rttWatchProvider.store.leaves.some(n=>n.scalar===9999));
    const recordingFinished=new Promise((resolve,reject)=>{disconnectRecording.stream.once('finish',resolve);disconnectRecording.stream.once('error',reject);});
    await vscode.debug.stopDebugging(binding.session);
    await recordingFinished;
    assert.equal(JSON.parse(fs.readFileSync(disconnectFile,'utf8').trim()).source.sessionId,binding.session.id);
    assert.equal(api.rttWatchProvider.recording,undefined);

    await until(()=>api.rttWatchProvider.store.roots.every(n=>!api.rttWatchProvider.store.isActive(n.id)));
    await until(() => !fs.existsSync(`${process.env.HOME}/.mcu-ai-debug/sessions/${binding.socket.record.id}.json`));
    // Add UART also works as a standalone monitor after F5 ends.
    const standalonePrepare=api.serialPortManager.prepareSerialPorts,standalonePick=vscode.window.showQuickPick,standaloneInput=vscode.window.showInputBox;
    api.serialPortManager.prepareSerialPorts=async()=>{};
    vscode.window.showQuickPick=async items=>items.find(item=>item.source?.port.path===uartDevice);
    vscode.window.showInputBox=async()=>"115200";
    try{await vscode.commands.executeCommand("mcu-debug.cockpit.addUart");}finally{
        api.serialPortManager.prepareSerialPorts=standalonePrepare;vscode.window.showQuickPick=standalonePick;vscode.window.showInputBox=standaloneInput;
    }
    assert.equal(uartOpens,2);
    uartConnection.write('standalone={"uart_only":123}\n');
    await until(()=>api.rttWatchProvider.store.leaves.some(node=>node.path[0]==="uart_only"&&node.scalar===123));
    assert(api.rttWatchProvider.store.roots.some(node=>api.rttWatchProvider.store.source(node.id).sessionName==="UART Monitor"));
    uartView.onUserClose();
    uartConnection.destroy();
    await new Promise(resolve => uartServer.close(resolve));
    rttConnection.destroy();
    await new Promise((resolve) => rttServer.close(resolve));
    factory.dispose();
};
