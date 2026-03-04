import * as path from "path";

export function isUnsafeRelativeSyncPath(inputPath: string): boolean {
    if (!inputPath) {
        return false;
    }
    const normalized = inputPath.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
        return true;
    }
    const parts = normalized.split("/").filter((segment) => segment.length > 0);
    return parts.some((segment) => segment === "..");
}

export function normalizeRelativeSyncPath(inputPath: string): string {
    const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));
    if (normalized === ".") {
        return "";
    }
    return normalized.startsWith("./") ? normalized.substring(2) : normalized;
}

export function resolveSyncRelativePathForFile(cwd: string, localFilePath: string, remotePath: string, remoteMustBeDir: boolean): string | null {
    const localRelToCwd = normalizeRelativeSyncPath(path.relative(cwd, localFilePath));
    const localIsUnderCwd = localRelToCwd.length > 0 && !isUnsafeRelativeSyncPath(localRelToCwd);
    const normalizedRemotePath = normalizeRelativeSyncPath(remotePath || "");
    let relativePath = "";

    if (localIsUnderCwd) {
        const remoteBase = remoteMustBeDir && !normalizedRemotePath ? "." : normalizedRemotePath || ".";
        relativePath = normalizeRelativeSyncPath(`${remoteBase}/${localRelToCwd}`);
    } else if (normalizedRemotePath) {
        if (remoteMustBeDir) {
            relativePath = normalizeRelativeSyncPath(`${normalizedRemotePath}/${path.basename(localFilePath)}`);
        } else {
            relativePath = normalizedRemotePath;
        }
    } else {
        relativePath = normalizeRelativeSyncPath(path.basename(localFilePath));
    }

    if (!relativePath || path.isAbsolute(relativePath) || isUnsafeRelativeSyncPath(relativePath)) {
        return null;
    }

    return relativePath;
}
