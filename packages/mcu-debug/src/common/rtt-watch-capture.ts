import * as fs from "node:fs";
import { once } from "node:events";
import { WatchFrame, WatchNode, WatchScalar, watchTransport, watchEndpoint } from "./rtt-watch";

const csv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
/** Streaming, bounded recording; each row corresponds to one received JSON frame, not a GUI refresh. */
export class RttWatchRecording {
    private closed = false;
    private failure?: Error;
    private constructor(private readonly stream: fs.WriteStream, private readonly format: "csv" | "jsonl",
        private readonly fields: WatchNode[], private readonly onError: (error: Error) => void) {
        stream.on("error", error => this.fail(error));
    }
    public static async create(file: string, format: "csv" | "jsonl", fields: WatchNode[], onError: (error: Error) => void): Promise<RttWatchRecording> {
        const stream = fs.createWriteStream(file, { flags: "w" });
        const recording = new RttWatchRecording(stream, format, fields, onError);
        await once(stream, "open");
        if (format === "csv") recording.write(["Timestamp", "Session", "Transport", "Endpoint", "Watch", ...fields.map(f => f.key!)].map(csv).join(",") + "\n");
        return recording;
    }
    public record(frame: WatchFrame): void {
        if (this.closed || this.failure) return;
        const fields = this.fields.filter(f => f.sourceId === frame.sourceId && f.watch === frame.watch);
        if (!fields.length) return;
        const values: Record<string, WatchScalar> = Object.create(null);
        for (const field of fields) values[field.key!] = frame.values[field.key!] ?? null;
        if (this.format === "jsonl") this.write(JSON.stringify({ timestamp: frame.timestamp, source: frame.source, watch: frame.watch, values }) + "\n");
        else this.write([frame.timestamp, frame.source.sessionId, watchTransport(frame.source), watchEndpoint(frame.source), frame.watch,
            ...this.fields.map(f => Object.hasOwn(values, f.key!) ? (typeof values[f.key!] === "string" ? values[f.key!] : JSON.stringify(values[f.key!])) : "")].map(csv).join(",") + "\n");
    }
    private write(line: string): void {
        if (this.failure) return;
        if (this.stream.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) {
            this.fail(new Error("JSON recording stopped: output file cannot keep up (4 MiB pending limit)")); return;
        }
        this.stream.write(line);
    }
    private fail(error: Error): void {
        if (this.failure) return;
        this.failure = error; this.closed = true; this.stream.destroy(); this.onError(error);
    }
    public async stop(): Promise<void> {
        if (this.failure) throw this.failure;
        if (this.closed) return;
        this.closed = true;
        const finished = once(this.stream, "finish"); this.stream.end(); await finished;
    }
}
