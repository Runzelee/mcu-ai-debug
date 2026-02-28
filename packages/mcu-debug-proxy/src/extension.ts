import * as vscode from "vscode";
import { computeProxyLaunchPolicy, ProxyHostType, resolveProxyNetworkMode } from "@mcu-debug/shared";

function resolveNetworkMode(hostType: ProxyHostType = "auto") {
    return resolveProxyNetworkMode(hostType, vscode.env.remoteName);
}

function computeLaunchPolicy(hostType: ProxyHostType = "auto") {
    const mode = resolveNetworkMode(hostType);
    return computeProxyLaunchPolicy(mode);
}

export function activate(context: vscode.ExtensionContext) {
    console.log("mcu-debug-proxy: Activating extension");

    const disposable = vscode.commands.registerCommand("mcu-debug-proxy.getNetworkPolicy", (hostType?: ProxyHostType) => {
        return computeLaunchPolicy(hostType || "auto");
    });
    context.subscriptions.push(disposable);

    console.log("mcu-debug-proxy: Extension activated");

    return {
        resolveNetworkMode,
        computeLaunchPolicy,
    };
}

export function deactivate() {
    console.log("mcu-debug-proxy: Deactivating extension");
}
