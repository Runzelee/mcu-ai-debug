export type ProxyHostType = "auto" | "ssh" | "local";

export type ProxyNetworkMode = "local" | "ssh" | "auto-local" | "auto-wsl" | "auto-dev-container" | "auto-ssh-remote" | `auto-${string}`;

export interface ProxyLaunchPolicy {
    mode: ProxyNetworkMode;
    bindHost: string;
    proxyHostForDA: string;
    reason: string;
}

export function resolveProxyNetworkMode(hostType: ProxyHostType = "auto", remoteName?: string): ProxyNetworkMode {
    if (hostType === "local") {
        return "local";
    }
    if (hostType === "ssh") {
        return "ssh";
    }

    if (!remoteName) {
        return "auto-local";
    }
    if (remoteName === "wsl") {
        return "auto-wsl";
    }
    if (remoteName === "dev-container") {
        return "auto-dev-container";
    }
    if (remoteName === "ssh-remote") {
        return "auto-ssh-remote";
    }
    return `auto-${remoteName}`;
}

export function computeProxyLaunchPolicy(mode: ProxyNetworkMode): ProxyLaunchPolicy {
    if (mode === "local" || mode === "auto-local" || mode === "ssh" || mode === "auto-ssh-remote") {
        return {
            mode,
            bindHost: "127.0.0.1",
            proxyHostForDA: "127.0.0.1",
            reason: "Loopback-only mode",
        };
    }

    if (mode === "auto-dev-container") {
        return {
            mode,
            bindHost: "0.0.0.0",
            proxyHostForDA: "host.docker.internal",
            reason: "Container reaches host through host.docker.internal",
        };
    }

    if (mode === "auto-wsl") {
        return {
            mode,
            bindHost: "0.0.0.0",
            proxyHostForDA: "<wsl-gateway-ip>",
            reason: "WSL mode may require host bind outside loopback for NAT",
        };
    }

    return {
        mode,
        bindHost: "127.0.0.1",
        proxyHostForDA: "127.0.0.1",
        reason: "Fallback policy",
    };
}
