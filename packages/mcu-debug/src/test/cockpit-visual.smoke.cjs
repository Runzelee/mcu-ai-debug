const fs = require("node:fs");
const cp = require("node:child_process");
const assert = require("node:assert/strict");

// Optional real Electron UI check. Only an isolated inline mock DAP/RTT session is used.
exports.run = async ({ vscode, entry, ownerId, cockpit, panel, uartView, uartConnection, base, port }) => {
    await vscode.commands.executeCommand("mcu-debug.cockpit.focus");
    await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    panel.activateTab(cockpit.tabId, false);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((target) => target.type === "page" && target.url.includes("workbench"));
    assert(target, "Electron workbench CDP target");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    const pending = new Map();
    let seq = 0;
    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++seq;
        fs.appendFileSync(`${base}/cdp.log`, `${id} ${method}\n`);
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 6000);
        pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const evaluate = async (expression, sessionId) => {
        const result = await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const until = async (fn) => {
        const deadline = Date.now() + 20000;
        while (!(await fn())) {
            if (Date.now() > deadline) throw new Error("Visual check timed out");
            await delay(80);
        }
    };
    const buttons = (text) => `[...document.querySelectorAll('.monaco-button')].filter(button => button.textContent.trim() === ${JSON.stringify(text)})`;
    const capture = async (name) => {
        await delay(400);
        const { data } = await call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${base}/${name}.png`, Buffer.from(data, "base64"));
    };
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    let webview;
    const sessions = new Map();
    const picker = `(() => {
        function find(doc) {
            const select = doc.querySelector('[aria-label="AI Cockpit session mode"]');
            if (select) return select;
            for (const frame of doc.querySelectorAll('iframe')) {
                try { if (frame.contentDocument) { const child = find(frame.contentDocument); if (child) return child; } } catch {}
            }
            return null;
        }
        return find(document);
    })()`;
    await until(async () => {
        const { targetInfos } = await call("Target.getTargets");
        for (const target of targetInfos.filter((target) => target.type === "iframe")) {
            let sessionId = sessions.get(target.targetId);
            if (!sessionId) {
                sessionId = (await call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
                sessions.set(target.targetId, sessionId);
            }
            if (await evaluate(`!!${picker}`, sessionId)) { webview = sessionId; return true; }
        }
        return false;
    });
    panel.activateTab(uartView.tabId, false);
    uartView.send("UART_CLEAR_ME\r\n");
    cockpit.send("KEEP_OTHER_TAB\r\n");
    const doc=`${picker}.ownerDocument`;
    await until(()=>evaluate(`${doc}.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes('UART') && !!${doc}.querySelector('[aria-label="Clear Terminal"]')`,webview));
    await evaluate(`${doc}.querySelector('[aria-label="Clear Terminal"]').click()`,webview);
    await delay(200);
    fs.writeFileSync(`${base}/uart-clear-state.json`,JSON.stringify({active:panel._activeTabId,uart:uartView.tabId,buffer:uartView._backingStore,other:cockpit._backingStore.slice(-300)}));
    await until(()=>uartView._backingStore==="");
    assert(cockpit._backingStore.includes("KEEP_OTHER_TAB"),"Clear must affect only the selected terminal");
    uartConnection.write("after-clear\n");
    await until(()=>uartView._backingStore.includes("after-clear"));
    await capture("uart-clear-terminal");
    panel.activateTab(cockpit.tabId, false);
    const options = await evaluate(`[...${picker}.options].map(option => option.textContent)`, webview);
    assert.deepEqual(options, ["Follow VS Code Debug", "Independent GDB Session"]);
    // Exercise the actual Svelte -> extension message -> settings -> F5 connection path.
    await evaluate(`${picker}.value='independent'; ${picker}.dispatchEvent(new Event('change',{bubbles:true}))`, webview);
    await until(() => cockpit.sessionMode === "independent" && !cockpit.attachedSocket);
    await capture("cockpit-independent-mode");
    await evaluate(`${picker}.value='current'; ${picker}.dispatchEvent(new Event('change',{bubbles:true}))`, webview);
    await until(() => cockpit.attachedRecord?.id === ownerId);
    await capture("cockpit-follow-f5-mode");
    // Reproduce a long real-world configuration name at wide/narrow sizes in both themes.
    const longConfig = "STM32F103C8T6: ST-Link DAP / MCU AI Debug";
    const originalConfig = cockpit.selectedConfigName;
    const originalConfigs = cockpit.launchConfigCache;
    cockpit.selectedConfigName = longConfig;
    cockpit.launchConfigCache = { ...originalConfigs, [longConfig]: { name: longConfig } };
    cockpit.postCockpitUiState();
    await until(() => evaluate(`${doc}.querySelector('[aria-label="Debug configuration"]')?.value === ${JSON.stringify(longConfig)}`, webview));
    const pickerLayouts = [];
    try {
        for (const [theme, colorTheme] of [["dark", "Default Dark Modern"], ["light", "Default Light Modern"]]) {
            await vscode.workspace.getConfiguration("workbench").update("colorTheme", colorTheme, vscode.ConfigurationTarget.Global);
            for (const width of [1280, 650]) {
                await call("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
                await delay(250);
                const layout = await evaluate(`(() => {
                    const doc = ${doc};
                    return [...doc.querySelectorAll('.select-control')].map(control => {
                        const select = control.querySelector('select'), arrow = control.querySelector('.select-arrow');
                        const bounds = select.getBoundingClientRect(), icon = arrow.getBoundingClientRect();
                        const padding = parseFloat(getComputedStyle(select).paddingRight);
                        return { name: select.getAttribute('aria-label'), padding,
                            gap: icon.left - (bounds.right - padding), arrowWidth: icon.width,
                            inside: icon.right <= bounds.right && bounds.right <= doc.documentElement.clientWidth,
                            title: select.title, value: select.value };
                    });
                })()`, webview);
                assert.equal(layout.length, 2);
                for (const select of layout) {
                    assert(select.gap >= 4 && select.arrowWidth === 16 && select.inside, `Dropdown text/arrow overlap: ${JSON.stringify(select)}`);
                }
                assert.equal(layout.find(select => select.name === "Debug configuration").title, longConfig);
                pickerLayouts.push({ theme, width, layout });
                await capture(`cockpit-dropdown-${theme}-${width}`);
            }
        }
        fs.writeFileSync(`${base}/cockpit-dropdown-layout.json`, JSON.stringify(pickerLayouts));
    } finally {
        cockpit.selectedConfigName = originalConfig;
        cockpit.launchConfigCache = originalConfigs;
        cockpit.postCockpitUiState();
        await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global);
        await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    }
    const child = cp.spawn("node", [entry, "manual", "--session", ownerId]);
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    let errors = "";
    child.stderr.on("data", (chunk) => errors += chunk);
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
        await until(() => evaluate(`${buttons("Start")}.length > 0`));
        await capture("manual-start-dark");
        await evaluate(`${buttons("Start")}[0].click()`);
        await until(async () => output.includes('"status":"USER_CONFIRMED"') && await evaluate(`${buttons("Stop")}.length > 0`));
        child.stdin.write("p real_ui_manual_counter\n");
        await until(() => output.includes("p real_ui_manual_counter") && output.includes("mock-gdb"));
        await capture("manual-active-dark");
        await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global);
        await call("Emulation.setDeviceMetricsOverride", { width: 650, height: 850, deviceScaleFactor: 1, mobile: false });
        await capture("manual-active-light-narrow");
        await evaluate(`${buttons("Stop")}[0].click()`);
        assert.equal(await exited, 0);
        assert(output.includes('"status":"USER_STOPPED"'));
        fs.writeFileSync(`${base}/manual-real-ui.json`, JSON.stringify({ visibleModeOptions: options, realModeChanges: true, realStartStopButtons: true, realClearTerminalButton:true, hardware: false, cliEndedOnStop: true }));
    } catch (error) {
        await capture("manual-ui-failed");
        fs.writeFileSync(`${base}/manual-ui-failed.json`, JSON.stringify({ output, errors, buttons: await evaluate("[...document.querySelectorAll('.monaco-button')].map(b => ({text:b.textContent,title:b.title}))") }));
        throw error;
    } finally {
        child.kill();
        await call("Emulation.clearDeviceMetricsOverride");
        await vscode.workspace.getConfiguration("workbench").update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global);
        socket.close();
    }
};
