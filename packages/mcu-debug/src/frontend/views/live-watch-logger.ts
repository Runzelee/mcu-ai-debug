import * as vscode from "vscode";
import * as fs from "fs";

export class LiveWatchLogger {
    private static instance: LiveWatchLogger;
    private writeStream: fs.WriteStream | undefined;
    private logFormat: "csv" | "jsonl" = "csv";
    private isRecordingFlag = false;
    private recordedKeys: string[] = [];
    /** Cache the most recent known value for each variable to fill columns when GDB hasn't pushed updates */
    private lastKnownValues: Map<string, string> = new Map();

    private constructor() {}

    public static getInstance(): LiveWatchLogger {
        if (!LiveWatchLogger.instance) {
            LiveWatchLogger.instance = new LiveWatchLogger();
        }
        return LiveWatchLogger.instance;
    }

    public get isRecording(): boolean {
        return this.isRecordingFlag;
    }

    public isKeyRecorded(key: string): boolean {
        return this.recordedKeys.includes(key);
    }

    public getRecordedKeys(): string[] {
        return this.recordedKeys;
    }

    public async startRecording(keys: string[]) {
        if (this.isRecordingFlag) {
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            title: "Save Live Watch Data",
            filters: {
                "CSV Files": ["csv"],
                "JSON Lines": ["jsonl"],
            },
            saveLabel: "Record",
        });

        if (!uri) {
            return;
        }

        this.logFormat = uri.fsPath.endsWith(".csv") ? "csv" : "jsonl";
        this.writeStream = fs.createWriteStream(uri.fsPath, { flags: "w" });
        this.isRecordingFlag = true;
        this.recordedKeys = keys;
        this.lastKnownValues.clear();

        if (this.logFormat === "csv") {
            const header = ["Timestamp", ...keys].map((k) => `"${k}"`).join(",");
            this.writeStream.write(header + "\n");
        }

        vscode.commands.executeCommand("setContext", "mcu-debug:isLiveWatchRecording", true);
    }

    public async saveSnapshot(variables: { [key: string]: string }) {
        const uri = await vscode.window.showSaveDialog({
            title: "Save Live Watch Snapshot",
            filters: {
                "JSON Files": ["json"],
            },
            saveLabel: "Save Snapshot",
        });

        if (!uri) {
            return;
        }

        const sanitizedVariables: { [key: string]: string } = {};
        for (const [key, value] of Object.entries(variables)) {
            sanitizedVariables[key] = this.sanitizeValue(value);
        }

        const payload = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            variable_count: Object.keys(sanitizedVariables).length,
            variables: sanitizedVariables,
        };

        await fs.promises.writeFile(uri.fsPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
        vscode.window.showInformationMessage("Live Watch snapshot saved as JSON.");
    }

    /**
     * Normalize raw strings returned by GDB.
     * GDB returns char/int8_t/uint8_t types in formats like `-1 '\\377'` or `65 'A'`,
     * and enums as `STATE_INIT = 0`.
     * This function preserves only the numeric portion for downstream processing and plotting.
     */
    private sanitizeValue(raw: string): string {
        if (!raw) return "";

        // Match GDB's char representation: a number followed by a space and a character literal in single quotes
        // e.g.: -1 '\\377', 65 'A', 0 '\\000'
        const charMatch = raw.match(/^(-?\d+)\s+'.*'$/);
        if (charMatch) {
            return charMatch[1];
        }

        // Match enum representation: NAME = number
        const enumMatch = raw.match(/^.*=\s*(-?\d+)$/);
        if (enumMatch) {
            return enumMatch[1];
        }

        return raw;
    }

    public record(timestamp: number, dataMap: { [key: string]: string }) {
        if (!this.isRecordingFlag || !this.writeStream) {
            return;
        }

        // Merge this update into the cache
        for (const k of this.recordedKeys) {
            if (dataMap[k] !== undefined) {
                this.lastKnownValues.set(k, this.sanitizeValue(dataMap[k]));
            }
        }

        // Only write a row if at least one key has a known value
        let hasAny = false;
        for (const k of this.recordedKeys) {
            if (this.lastKnownValues.has(k)) {
                hasAny = true;
                break;
            }
        }
        if (!hasAny) return;

        if (this.logFormat === "csv") {
            const row = [
                timestamp.toString(),
                ...this.recordedKeys.map((k) => {
                    const val = this.lastKnownValues.get(k) ?? "";
                    return `"${String(val).replace(/"/g, '""')}"`;
                }),
            ].join(",");
            this.writeStream.write(row + "\n");
        } else {
            const obj: { [key: string]: string | number } = { timestamp };
            for (const k of this.recordedKeys) {
                obj[k] = this.lastKnownValues.get(k) ?? "";
            }
            this.writeStream.write(JSON.stringify(obj) + "\n");
        }
    }

    public stopRecording() {
        if (!this.isRecordingFlag) {
            return;
        }

        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = undefined;
        }

        this.isRecordingFlag = false;
        this.lastKnownValues.clear();
        vscode.commands.executeCommand("setContext", "mcu-debug:isLiveWatchRecording", false);
        vscode.window.showInformationMessage("Live Watch data recording stopped and saved.");
    }
}
