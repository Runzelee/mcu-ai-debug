import test from "node:test";
import assert from "node:assert/strict";
import { isUnsafeRelativeSyncPath, resolveSyncRelativePathForFile } from "../adapter/sync-files-utils";

test("inside cwd preserves relative path when remote is missing", () => {
    const result = resolveSyncRelativePathForFile("/ws", "/ws/dir/file.elf", "", false);
    assert.equal(result, "dir/file.elf");
});

test("absolute local outside cwd with explicit remote file path", () => {
    const result = resolveSyncRelativePathForFile("/ws", "/a/b.txt", "./b.txt", false);
    assert.equal(result, "b.txt");
});

test("absolute local outside cwd with explicit remote dir and multi-match", () => {
    const result = resolveSyncRelativePathForFile("/ws", "/a/b.txt", "./sym", true);
    assert.equal(result, "sym/b.txt");
});

test("absolute local outside cwd with no remote falls back to basename", () => {
    const result = resolveSyncRelativePathForFile("/ws", "/a/b.txt", "", false);
    assert.equal(result, "b.txt");
});

test("rejects remote path traversal", () => {
    assert.equal(isUnsafeRelativeSyncPath("../bad"), true);
    const result = resolveSyncRelativePathForFile("/ws", "/a/b.txt", "../bad", false);
    assert.equal(result, null);
});

test("rejects empty destination after normalization", () => {
    const result = resolveSyncRelativePathForFile("/ws", "/ws/dir/file.elf", "./", false);
    assert.equal(result, "dir/file.elf");
});

test("treats Windows absolute paths as unsafe relative destinations", () => {
    assert.equal(isUnsafeRelativeSyncPath("C:/temp/file.elf"), true);
    assert.equal(isUnsafeRelativeSyncPath("C:\\temp\\file.elf"), true);
});

test("detects Windows traversal in relative paths", () => {
    assert.equal(isUnsafeRelativeSyncPath("..\\secrets\\file.txt"), true);
    assert.equal(isUnsafeRelativeSyncPath("safe\\nested\\file.txt"), false);
});

test("WSL client path outside cwd with explicit remote file path", () => {
    const result = resolveSyncRelativePathForFile("/home/me/ws", "/mnt/c/fw/build/app.elf", "./symbols/app.elf", false);
    assert.equal(result, "symbols/app.elf");
});

test("normalizes mixed separators in remote dir path", () => {
    const result = resolveSyncRelativePathForFile("/home/me/ws", "/mnt/c/fw/build/app.elf", ".\\symbols\\dbg", true);
    assert.equal(result, "symbols/dbg/app.elf");
});

test("detects mixed-separator traversal", () => {
    assert.equal(isUnsafeRelativeSyncPath("symbols\\..\\escape.bin"), true);
});
