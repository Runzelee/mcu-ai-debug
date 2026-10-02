import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import winston from "winston";
import { CLIConfigLoader } from "../cli/cli-config-loader";
import { IHostAdapter, setHostAdapter } from "../common/host-adapter";

const messages: string[] = [];
setHostAdapter({
    getGdbServerConsolePort: async () => 3333,
    getUsedPorts: () => [],
    getSetting: (_section: string, _key: string, fallback: unknown) => fallback,
    getExtensionPath: () => "/tmp/extension",
    getWorkspaceFilePath: () => undefined,
    findChainedSession: () => undefined,
    getRemoteName: () => undefined,
    handleHostConfig: async () => {},
    showError: (message: string) => messages.push(message),
    showWarning: (message: string) => messages.push(message),
    showInfo: () => {},
} as unknown as IHostAdapter);
const logger = { info: () => {}, warn: () => {}, error: (message: string) => messages.push(message) } as unknown as winston.Logger;

test("repeated cockpit loads resolve workspaceRoot without rewriting cached launch.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-config-"));
    try {
        fs.mkdirSync(path.join(root, "build"));
        fs.writeFileSync(path.join(root, "build/test.elf"), "");
        const config = Object.freeze({
            name: "STM32 Debug", type: "mcu-debug", request: "launch", servertype: "openocd",
            cwd: "${workspaceRoot}", executable: "${workspaceRoot}/build/test.elf",
            symbolFiles: ["${workspaceRoot}/build/test.elf"],
            configFiles: ["interface/cmsis-dap.cfg", "target/stm32h7x.cfg"],
            liveWatch: { enabled: true },
        });
        const baseline = structuredClone(config);
        const args = { config: config.name, configParsed: config, builtins: CLIConfigLoader.gatherBuiltins(root) };
        const loader = new CLIConfigLoader(args, logger, true);
        for (let attempt = 0; attempt < 3; ++attempt) {
            const resolved = await loader.loadConfiguration(args);
            assert.ok(resolved, messages.join("\n"));
            assert.equal(resolved.cwd, root);
            assert.equal(resolved.executable, path.join(root, "build/test.elf"));
            assert.equal(resolved.symbolFiles?.[0].file, resolved.executable);
            assert.deepEqual(config, baseline);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("normalizes a relative working directory exactly once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcu-config-"));
    try {
        fs.mkdirSync(path.join(root, "build"));
        fs.writeFileSync(path.join(root, "build/test.elf"), "");
        const args = { config: "relative", builtins: CLIConfigLoader.gatherBuiltins(root), configParsed: {
            name: "relative", type: "mcu-debug", request: "launch", servertype: "openocd",
            cwd: "build", executable: "test.elf", configFiles: ["target/stm32h7x.cfg"],
        } };
        const resolved = await new CLIConfigLoader(args, logger, false).loadConfiguration(args);
        assert.ok(resolved, messages.join("\n"));
        assert.equal(resolved.cwd, path.join(root, "build"));
        assert.equal(resolved.executable, path.join(root, "build/test.elf"));
        assert.equal(args.configParsed.cwd, "build");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unresolved command variables never reach path normalization", async () => {
    const args = { config: "unresolved", configParsed: {
        name: "unresolved", type: "mcu-debug", cwd: "${workspaceRoot}",
        executable: "${command:cmake.launchTargetPath}",
    } };
    const baseline = structuredClone(args.configParsed);
    assert.equal(await new CLIConfigLoader(args, logger, false).loadConfiguration(args), undefined);
    assert.deepEqual(args.configParsed, baseline);
});

test("CLI selects a unique case-insensitive substring without breaking exact names", () => {
    const loader = new CLIConfigLoader({config: ""}, logger, false) as any;
    const configs = [{name: "OpenOCD (STM32F429)"}, {name: "J-Link"}, {name: "openocd"}];
    assert.equal(loader.selectConfiguration(configs, {config: "openocd"}), configs[2]);
    assert.equal(loader.selectConfiguration(configs.slice(0, 2), {config: "OPENOCD"}), configs[0]);
    assert.equal(loader.selectConfiguration(configs.slice(0, 2), {config: "STM32*"}), configs[0]);
});
