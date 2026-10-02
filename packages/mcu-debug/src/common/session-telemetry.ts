import { EventEmitter } from "node:events";

export interface SessionTelemetry {
    sessionId: string;
    source: "RTT" | "serial" | "GDB-SERVER";
    prefix: string;
    channel?: number;
    port?: string;
    host?: string;
    hostName?: string;
    sessionName?: string;
    data: Buffer;
}
// A tap on existing connections, not another target reader or polling loop.
export const sessionTelemetry = new EventEmitter();
