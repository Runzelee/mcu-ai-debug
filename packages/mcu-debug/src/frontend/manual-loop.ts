import * as vscode from "vscode";
import { ManualSessionManager, ManualState } from "../common/manual-session";

/** VS Code only supplies confirmation UI. The agent's interaction stays on the CLI. */
export class ManualLoop extends ManualSessionManager {
    constructor(publish: (state: ManualState) => void) {
        super((name, button, signal) => this.prompt(name, button, signal), publish);
    }
    private async prompt(name: string, button: "Start" | "Stop", signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return false;
        let abort = () => {};
        const cancelled = new Promise<undefined>((resolve) => {
            abort = () => resolve(undefined);
            signal.addEventListener("abort", abort, { once: true });
        });
        const message =
            button === "Start"
                ? `Manual CLI interaction (${name}): click Start to let the agent interact through GDB/RTT/UART.`
                : `Manual CLI interaction active (${name}). The agent uses GDB/RTT/UART. Click Stop to end the interaction.`;
        try {
            const answer = await Promise.race([vscode.window.showInformationMessage(message, button, "Cancel"), cancelled]);
            return !signal.aborted && answer === button;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }
}
