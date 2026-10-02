import { randomUUID } from "node:crypto";

export interface ManualState {
    ownerId: string;
    manualId: string;
    name: string;
    state: "waiting" | "active" | "ended";
    status: "WAITING_FOR_USER" | "USER_CONFIRMED" | "USER_STOPPED" | "CANCELLED_BY_USER" | "SESSION_ENDED";
}
type Flow = {
    snapshot: ManualState;
    abort: AbortController;
    done: Promise<ManualState>;
    resolve: (state: ManualState) => void;
    cleanup: () => void;
};

/** Human coordination only. GDB/RTT/UART keep their existing transport and ownership. */
export class ManualSessionManager {
    private readonly flows = new Map<string, Flow>();
    constructor(
        private readonly ask: (name: string, button: "Start" | "Stop", signal: AbortSignal) => Promise<boolean>,
        private readonly publish: (state: ManualState) => void,
    ) {}
    status(ownerId: string): ManualState | { ownerId: string; state: "idle"; status: "IDLE" } {
        return { ...(this.flows.get(ownerId)?.snapshot ?? { ownerId, state: "idle", status: "IDLE" }) };
    }
    private finish(flow: Flow, status: ManualState["status"]): void {
        if (flow.snapshot.state === "ended") return;
        flow.snapshot = { ...flow.snapshot, state: "ended", status };
        flow.cleanup();
        flow.abort.abort();
        flow.resolve({ ...flow.snapshot });
        this.publish({ ...flow.snapshot });
    }
    async start(ownerId: string, name: string, ownerSignal: AbortSignal, clientSignal: AbortSignal): Promise<ManualState> {
        const previous = this.flows.get(ownerId);
        if (previous && previous.snapshot.state !== "ended") throw new Error("A manual interaction is already pending or active for this session");
        if (ownerSignal.aborted || clientSignal.aborted) throw new Error("Session or client disconnected");
        let resolve!: Flow["resolve"];
        const flow: Flow = {
            snapshot: { ownerId, manualId: randomUUID(), name, state: "waiting", status: "WAITING_FOR_USER" },
            abort: new AbortController(),
            done: new Promise<ManualState>((done) => {
                resolve = done;
            }),
            resolve: (state) => resolve(state),
            cleanup: () => ownerSignal.removeEventListener("abort", ended),
        };
        const ended = () => this.finish(flow, "SESSION_ENDED");
        const detached = () => this.finish(flow, "CANCELLED_BY_USER");
        this.flows.set(ownerId, flow);
        ownerSignal.addEventListener("abort", ended, { once: true });
        clientSignal.addEventListener("abort", detached, { once: true });
        this.publish({ ...flow.snapshot });
        try {
            const accepted = await this.ask(name, "Start", flow.abort.signal);
            if (flow.snapshot.state === "ended") return { ...flow.snapshot };
            if (!accepted) {
                this.finish(flow, "CANCELLED_BY_USER");
                return { ...flow.snapshot };
            }
            // A one-shot start client can detach; the debug session now owns the interaction.
            clientSignal.removeEventListener("abort", detached);
            flow.snapshot = { ...flow.snapshot, state: "active", status: "USER_CONFIRMED" };
            this.publish({ ...flow.snapshot });
            void this.ask(name, "Stop", flow.abort.signal).then(
                (stopped) => this.finish(flow, stopped ? "USER_STOPPED" : "CANCELLED_BY_USER"),
                () => this.finish(flow, "CANCELLED_BY_USER"),
            );
            return { ...flow.snapshot };
        } catch (error) {
            this.finish(flow, "CANCELLED_BY_USER");
            throw error;
        } finally {
            clientSignal.removeEventListener("abort", detached);
        }
    }
    async wait(ownerId: string, signal: AbortSignal): Promise<ManualState> {
        const flow = this.flows.get(ownerId);
        if (!flow) throw new Error("No manual interaction. Run manual start first");
        if (signal.aborted) throw new Error("Client disconnected");
        let abort = () => {};
        try {
            return await Promise.race([
                flow.done,
                new Promise<never>((_, reject) => {
                    abort = () => reject(new Error("Client disconnected"));
                    signal.addEventListener("abort", abort, { once: true });
                }),
            ]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }
    dispose(): void {
        for (const flow of this.flows.values()) this.finish(flow, "SESSION_ENDED");
        this.flows.clear();
    }
}
