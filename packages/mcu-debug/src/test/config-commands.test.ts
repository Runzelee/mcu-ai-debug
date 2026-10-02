import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfigurationCommands } from "../common/config-commands";

test("resolves a CMake target once across nested configuration fields without mutating the cache", async () => {
    const original = {
        executable: "${command:cmake.launchTargetPath}",
        loadFiles: ["${command:cmake.launchTargetPath}"],
        rttConfig: { decoder: "prefix:${command:cmake.launchTargetPath}" },
    };
    const baseline = structuredClone(original);
    let calls = 0;
    const resolved = await resolveConfigurationCommands(original, async (command, configuration) => {
        assert.equal(command, "cmake.launchTargetPath");
        assert.equal(configuration, original);
        ++calls;
        return "/tmp/build/h7_mainboard.elf";
    });
    assert.equal(calls, 1);
    assert.deepEqual(original, baseline);
    assert.equal(resolved.executable, "/tmp/build/h7_mainboard.elf");
    assert.deepEqual(resolved.loadFiles, [resolved.executable]);
    assert.equal(resolved.rttConfig.decoder, "prefix:" + resolved.executable);
});

test("command paths preserve literal dollar signs and backslashes", async () => {
    const path = "C:\\firmware\\$target.elf";
    assert.equal(await resolveConfigurationCommands("${command:target}", async () => path), path);
});

test("rejects cancelled or non-string command results before launching", async () => {
    await assert.rejects(resolveConfigurationCommands("${command:target}", async () => undefined), /did not return a string/);
    await assert.rejects(resolveConfigurationCommands("${command:target}", async () => 42), /did not return a string/);
});
