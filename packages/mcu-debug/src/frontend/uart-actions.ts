import * as vscode from "vscode";
import { SerialPortManager, SourcedPort } from "../common/serial-manager";
import { uartParams, normalizeUartPath } from "../common/uart-config";
import { SerialPortView } from "./serial-view";
import { CockpitPanel } from "./views/CockpitPanel";

/** One explicit user action opens one backend-owned port, shared by terminal, CLI and JSON Watch. */
export async function addUart(manager: SerialPortManager, getSessions: () => vscode.DebugSession[], panel: CockpitPanel): Promise<void> {
    try {
        const sessions = getSessions();
        let session = sessions.length === 1 ? sessions[0] : undefined;
        if (sessions.length > 1) {
            const choice = await vscode.window.showQuickPick([
                ...sessions.map(session => ({ label: session.name, description: session.id.slice(0, 8), session })),
                { label: "Standalone UART monitor", description: "Open without a debug session", session: undefined },
            ], { title: "UART Session", placeHolder: "Choose the session that CLI clients will use" });
            if (!choice) return;
            session = choice.session;
        }
        await manager.prepareSerialPorts(session?.configuration.hostConfig);
        const ports = manager.getAllAvailablePorts();
        const choices = ports.map(source => ({ label: source.port.path, description: `${source.label} · ${source.port.description || "Serial port"}`,
            detail: `VID ${source.port.vid?.toString(16).padStart(4, "0") ?? "N/A"} · PID ${source.port.pid?.toString(16).padStart(4, "0") ?? "N/A"} · Serial ${source.port.serial ?? "N/A"}`,
            source: source as SourcedPort | undefined }));
        choices.push({ label: "Enter device path or COM port...", description: "Manual selection", detail: "Linux/macOS device path or Windows COM port", source: undefined });
        const choice = await vscode.window.showQuickPick(choices, { title: "Add UART", placeHolder: "Select the USB adapter or virtual COM port connected to your MCU" });
        if (!choice) return;
        const device = choice.source?.port.path ?? await vscode.window.showInputBox({ title: "UART Device", prompt: "Enter a device on the selected probe host, for example /dev/ttyUSB0 or COM3",
            validateInput: value => normalizeUartPath(value) ? undefined : "Enter a serial device path or COM port" });
        if (device === undefined) return;
        const baud = await vscode.window.showInputBox({ title: "UART Baud Rate", value: "115200", prompt: "Match the firmware baud rate (8 data bits, no parity, 1 stop bit)",
            validateInput: value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 4000000 ? undefined : "Enter a baud rate between 1 and 4000000" });
        if (baud === undefined) return;
        if (session && !getSessions().some(current => current.id === session.id)) throw new Error("The selected debug session ended. Add UART again to choose another session.");
        const owner = session ? session.configuration.pvtSerialSessionToken || `uart-ui:${session.id}` : undefined;
        if (session && owner) SerialPortView.bindSession(session.id, owner);
        const view = await manager.openSerialPortForUser(uartParams(device, Number(baud)), choice.source?.proxyKey, owner, session?.configuration.hostConfig);
        const tab = view as SerialPortView;
        panel.activateTab(tab.tabId);
        panel.show(false);
    } catch (error) {
        void vscode.window.showErrorMessage(`Could not open UART: ${error instanceof Error ? error.message : String(error)}`);
    }
}
