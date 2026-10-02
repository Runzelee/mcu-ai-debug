import { StringDecoder } from "node:string_decoder";

export type WatchScalar = string | number | boolean | null;
export type WatchValue = WatchScalar | WatchValue[] | { [key: string]: WatchValue };
export interface WatchSource { sessionId: string; sessionName: string; transport?: "RTT" | "UART"; channel?: number; port?: string; host?: string; hostName?: string; label: string; }
export interface WatchNode {
    id: string; label: string; value: string; children: string[]; scalar?: WatchScalar;
    key?: string; sourceId: string; watch: string; path: string[]; changed: boolean;
}
export interface WatchFrame {
    timestamp: number; source: WatchSource; sourceId: string; watch: string;
    values: Record<string, WatchScalar>; nodes: string[]; structureChanged: boolean;
}
type Stream = {
    source: WatchSource; id: string; decoder: StringDecoder; pending: string; discarding: boolean;
    watches: Map<string, string[]>; root: WatchNode; active: boolean; ended: boolean; sampledAt?: number;
};
const MAX_LINE = 65536, MAX_NODES = 4096, MAX_DEPTH = 16, MAX_STREAMS = 64;
const identity = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString("base64url");
export const displayWatchValue = (value: WatchValue) => typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);

export const watchTransport = (source: WatchSource): "RTT" | "UART" => source.transport ?? "RTT";
export const watchEndpoint = (source: WatchSource): string => watchTransport(source) === "UART" ? source.port ?? source.label : String(source.channel ?? 0);
export const watchSourceLabel = (source: WatchSource): string => `${watchTransport(source)} ${watchEndpoint(source)}${source.hostName ? ` (${source.hostName})` : ""}`;
const sourceIdentity = (source: WatchSource): string => watchTransport(source) === "UART"
    ? identity([source.sessionId, "UART", source.host ?? "", watchEndpoint(source)]) : identity([source.sessionId, source.channel ?? 0]);

/** Newline-framed JSON only; regular console text is ignored, never evaluated as code. */
export function parseWatchLine(line: string): { watch: string; value: WatchValue } | undefined {
    line = line.trim();
    if (!line || line.length > MAX_LINE) return;
    let watch = "JSON", json = line;
    const named = /^([A-Za-z_][A-Za-z0-9_.:/-]{0,127})\s*=\s*([\[{][\s\S]*)$/.exec(line);
    if (named) { watch = named[1]; json = named[2]; }
    if (!json.startsWith("{") && !json.startsWith("[")) return;
    try {
        const value = JSON.parse(json);
        if (value === null || typeof value !== "object") return;
        return { watch, value };
    } catch { return; }
}

/** A bounded cache of full snapshots per session/transport/endpoint/watch, fed by existing RTT or UART connections. */
export class RttWatchStore {
    public readonly nodes = new Map<string, WatchNode>();
    private readonly streams = new Map<string, Stream>();
    public get roots(): WatchNode[] { return [...this.streams.values()].map(s => s.root); }
    public get leaves(): WatchNode[] { return [...this.nodes.values()].filter(n => n.key !== undefined); }
    public isActive(id: string): boolean { return this.streams.get(id)?.active ?? false; }
    public sampledAt(id: string): number | undefined { return this.streams.get(id)?.sampledAt; }
    public source(id: string): WatchSource | undefined { return this.streams.get(id)?.source; }
    public clear(): void { this.streams.clear(); this.nodes.clear(); }
    public endSession(sessionId: string): void {
        for (const stream of this.streams.values()) if (stream.source.sessionId === sessionId) {
            stream.ended = true; this.disconnect(stream);
        }
    }
    public endSource(source: WatchSource): void {
        const stream = this.streams.get(sourceIdentity(source));
        if (stream) this.disconnect(stream);
    }
    private disconnect(stream: Stream): void {
        stream.active = false; stream.pending = ""; stream.discarding = false; stream.decoder = new StringDecoder("utf8");
    }
    public feed(source: WatchSource, data: Buffer, timestamp = Date.now()): WatchFrame[] {
        source = { ...source, transport: watchTransport(source) };
        const id = sourceIdentity(source);
        let stream = this.streams.get(id);
        // Do not retain ordinary text-only/binary streams in the variable tree.
        if (!stream) {
            if (this.streams.size >= MAX_STREAMS) {
                const expired = [...this.streams.values()].find(s => !s.active);
                if (!expired) return [];
                this.removeStream(expired);
            }
            stream = { source, id, decoder: new StringDecoder("utf8"), pending: "", discarding: false,
                watches: new Map(), active: true, ended: false,
                root: { id, label: `${source.sessionName} [${source.sessionId.slice(0, 8)}] / ${watchSourceLabel(source)} ${source.label}`,
                    value: "", children: [], sourceId: id, watch: "", path: [], changed: false } };
            this.streams.set(id, stream);
        }
        if (stream.ended) return [];
        const reconnected = !stream.active;
        stream.active = true;
        stream.source = source;
        const text = stream.decoder.write(data), frames: WatchFrame[] = [];
        let offset = 0;
        while (offset < text.length) {
            const newline = text.indexOf("\n", offset), end = newline < 0 ? text.length : newline;
            if (!stream.discarding) {
                if (stream.pending.length + end - offset > MAX_LINE) { stream.pending = ""; stream.discarding = true; }
                else stream.pending += text.slice(offset, end);
            }
            if (newline < 0) break;
            if (!stream.discarding) {
                const record = parseWatchLine(stream.pending);
                if (record) {
                    const frame = this.apply(stream, record.watch, record.value, timestamp);
                    if (frame) { frame.structureChanged ||= reconnected; frames.push(frame); }
                }
            }
            stream.pending = ""; stream.discarding = false; offset = newline + 1;
        }
        return frames;
    }
    private removeStream(stream: Stream): void {
        for (const ids of stream.watches.values()) for (const id of ids) this.nodes.delete(id);
        this.nodes.delete(stream.id); this.streams.delete(stream.id);
    }
    private apply(stream: Stream, watch: string, value: WatchValue, timestamp: number): WatchFrame | undefined {
        const next = new Map<string, WatchNode>(), values: Record<string, WatchScalar> = Object.create(null);
        let valid = true;
        const walk = (data: WatchValue, path: string[], label: string): string => {
            const id = identity([stream.id, watch, ...path]);
            if (path.length > MAX_DEPTH || next.size >= MAX_NODES) { valid = false; return id; }
            const container = data !== null && typeof data === "object";
            if (!container && typeof data === "number" && !Number.isFinite(data)) valid = false;
            const previous = this.nodes.get(id);
            const node: WatchNode = { id, label, value: container ? (Array.isArray(data) ? `Array(${data.length})` : "Object") : displayWatchValue(data),
                children: [], sourceId: stream.id, watch, path, changed: previous?.value !== undefined && previous.value !== displayWatchValue(data) };
            next.set(id, node);
            if (container) {
                for (const [name, child] of Object.entries(data)) {
                    if (!valid) break;
                    node.children.push(walk(child, [...path, name], Array.isArray(data) ? `[${name}]` : name));
                }
                node.changed = false;
            } else {
                node.scalar = data as WatchScalar;
                // JSON Pointer escapes keep keys containing '/' or '~' unambiguous.
                const pointer = [watch, ...path].map(p => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
                const endpoint = watchTransport(stream.source) === "UART" ? `UART${encodeURIComponent([stream.source.host, watchEndpoint(stream.source)].filter(Boolean).join("/"))}` : `RTT${stream.source.channel ?? 0}`;
                node.key = `${stream.source.sessionId}/${endpoint}/${pointer}`;
                values[node.key] = node.scalar;
            }
            return id;
        };
        const root = walk(value, [], watch);
        if (!valid || [...stream.watches.values()].reduce((n, ids) => n + ids.length, 0) - (stream.watches.get(watch)?.length ?? 0) + next.size > MAX_NODES) return;
        const old = stream.watches.get(watch) ?? [];
        const structureChanged = old.length !== next.size || old.some(id => !next.has(id)) || old.some(id => {
            const a = this.nodes.get(id), b = next.get(id);
            return a?.children.join(",") !== b?.children.join(",") || (a?.key !== undefined) !== (b?.key !== undefined);
        });
        for (const id of old) this.nodes.delete(id);
        for (const [id, node] of next) this.nodes.set(id, node);
        stream.watches.set(watch, [...next.keys()]);
        if (!stream.root.children.includes(root)) stream.root.children.push(root);
        stream.sampledAt = timestamp; this.nodes.set(stream.id, stream.root);
        return { timestamp, source: { ...stream.source }, sourceId: stream.id, watch, values, nodes: [...next.keys()], structureChanged };
    }
}
