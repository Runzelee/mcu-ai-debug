import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// Authored and consumed by TypeScript only. Native attach still uses its existing socket metadata.
export interface AISessionRecord {
    id: string;
    kind: "f5" | "cli" | "cockpit";
    pid: number;
    processStart?: string;
    socket?: string;
    pipe?: string;
    cwd: string;
    config: string;
    started: string;
    status: string;
    windowId?: string;
    executable?: string;
}

export function processStart(pid: number): string | undefined {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch {
        return undefined;
    }
}

export class SessionRegistry {
    constructor(public readonly directory = path.join(os.homedir(), ".mcu-ai-debug", "sessions")) {}
    private file(id: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
        return path.join(this.directory, `${id}.json`);
    }
    create(details: Pick<AISessionRecord, "kind" | "cwd" | "config"> & Partial<AISessionRecord>): AISessionRecord {
        return {
            id: randomUUID(),
            pid: process.pid,
            processStart: processStart(process.pid),
            started: new Date().toISOString(),
            status: "starting",
            ...details,
        };
    }
    write(record: AISessionRecord): void {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const file = this.file(record.id);
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    remove(id: string): void {
        fs.rmSync(this.file(id), { force: true });
    }
    list(): AISessionRecord[] {
        if (!fs.existsSync(this.directory)) return [];
        const records: AISessionRecord[] = [];
        for (const name of fs.readdirSync(this.directory).filter((name) => name.endsWith(".json"))) {
            const file = path.join(this.directory, name);
            try {
                const record = JSON.parse(fs.readFileSync(file, "utf8")) as AISessionRecord;
                if (
                    name !== `${record.id}.json` ||
                    !Number.isInteger(record.pid) ||
                    record.pid <= 0 ||
                    !["f5", "cli", "cockpit"].includes(record.kind) ||
                    typeof record.cwd !== "string" ||
                    !(typeof record.socket === "string" || typeof record.pipe === "string")
                )
                    throw new Error("Invalid record");
                // Never connect to probe liveness: a CLI --nostdin session ends when its last client leaves.
                try {
                    process.kill(record.pid, 0);
                    if (record.processStart && processStart(record.pid) !== record.processStart)
                        throw new Error("PID reused");
                    if (record.socket && !fs.existsSync(record.socket)) throw new Error("Socket removed");
                } catch (error: any) {
                    if (error.code === "EPERM") {
                        records.push(record);
                        continue;
                    }
                    fs.rmSync(file, { force: true });
                    continue;
                }
                records.push(record);
            } catch {
                /* Ignore foreign/malformed records. */
            }
        }
        return records.sort((a, b) => a.started.localeCompare(b.started));
    }
}

export function selectSession(records: AISessionRecord[], id: string | undefined, cwd: string): AISessionRecord {
    const candidates = id
        ? records.filter((record) => record.id === id || record.id.startsWith(id))
        : records.filter((record) => path.resolve(record.cwd) === path.resolve(cwd));
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length)
        throw new Error(
            id
                ? `No active session matching ${id}`
                : "No active session for this workspace. Run mcu-ai-debug sessions and use attach --session ID.",
        );
    throw new Error(
        `Multiple sessions match. Use attach --session ID: ${candidates.map((record) => `${record.id} (${record.kind}: ${record.config})`).join(", ")}`,
    );
}
