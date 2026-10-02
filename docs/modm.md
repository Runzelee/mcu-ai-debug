# modm Cortex-M projects

MCU AI Debug works with modm-generated ARM Cortex-M ELF files. SCons/lbuild does not require a separate debug adapter; the relevant settings are the actual Debug ELF, build task, OpenOCD configuration and enabled Live Watch/RTT services. This guide covers Cortex-M projects, not modm's AVR targets.

## Debug configuration

Use the project root as the VS Code workspace, a Debug build with DWARF information, and a pre-launch task that calls your existing build script. A typical SCons project outputs `build/scons-debug/<project>.elf`; verify the actual path instead of using a CMake command variable in a SCons-only project.

```json
{
  "name": "modm: OpenOCD",
  "type": "mcu-debug",
  "request": "launch",
  "servertype": "openocd",
  "cwd": "${workspaceFolder}/app/pb8",
  "executable": "${workspaceFolder}/build/scons-debug/pb8.elf",
  "gdbPath": "/usr/bin/arm-none-eabi-gdb",
  "serverpath": "/usr/bin/openocd",
  "configFiles": ["${workspaceFolder}/app/pb8/openocd.cfg"],
  "preLaunchTask": "modm: build debug",
  "runToEntryPoint": "main",
  "liveWatch": {"enabled": true, "samplesPerSecond": 20},
  "rttConfig": {
    "enabled": true,
    "address": "auto",
    "polling_interval": 10,
    "useBuiltinRTT": {"enabled": false},
    "decoders": [{"label": "pb8_debug", "port": 0, "type": "console"}]
  }
}
```

Only enable `rttConfig` when the firmware includes RTT. Use your application/probe OpenOCD configuration without an early `init`, `reset`, `program` or `shutdown`. modm's generated wrapper `modm/openocd.cfg` contains an `init` in the tested checkout; passing it directly can initialize before the extension has configured its extra GDB connection. The extension arranges server initialization and RTT ports. Do not also execute `modm_rtt` or start a second RTT service for the same session.

For a recent ST-Link, an application configuration can use `interface/stlink-dap.cfg` and `transport select dapdirect_swd`, followed by the matching target configuration. Keep HLA as an explicit compatibility configuration for older probe firmware; the driver name and transport must match. Both tested STM32F103 configurations allow two GDB connections in an offline OpenOCD configuration check. Hardware/firmware compatibility still requires a probe test.

## C++ live variables and CLI

Version 0.1.26 fixes the helper's DWARF traversal so symbols inside later C++ namespaces are included in global lists; repeated header declarations are deduplicated.

Add fully qualified expressions such as `app::pb8_debug`, `app::pb8_debug.toggle_count`, `SystemCoreClock` or `modm::platform::delay_fcpu_MHz` to **GDB Live Watch**. Expand structs normally. GDB's C++ access groups are handled by the adapter. Running-target reads should use persistent global/static RAM state, rather than a local variable tied to the currently selected stack frame. A peripheral template type or an optimized/compile-time value is not a persistent RAM telemetry variable.

Set **AI Cockpit → Follow VS Code Debug** to share F5. Keep MCP disabled. For an agent, select the correct session across windows and use Live GDB without changing panel subscriptions:

```text
mcu-ai-debug sessions
mcu-ai-debug attach --session <session-id>
+p app::pb8_debug
+x/5uw &app::pb8_debug
```

## RTT firmware

Select the official `modm:rtt` module in `project.xml`, set `modm:rtt:buffer.tx` / `.rx`, and initialize its `ext/segger/rtt` submodule. lbuild generates `SEGGER_RTT.h` and the RTT implementation; modm's constructor initializes RTT before `main`. Use that implementation instead of a second copy of SEGGER RTT.

Print UTF-8 JSON Lines, for example:

```text
pb8_debug={"toggle_count":1,"period_ms":50,"core_clock_hz":8000000,"output_high":true,"rtt_skipped":0}
```

Use one bounded, non-blocking `SEGGER_RTT_Write` per complete record and `SEGGER_RTT_MODE_NO_BLOCK_SKIP`. **RTT Live Watch** reads the existing console channel automatically and supports independent graphs, JSON snapshots and JSONL/CSV recording. **Copy Firmware Prompt** copies English instructions for an agent to generate compatible firmware. Pausing a graph affects its display, not the independent recorder or firmware.

The local example `/home/runze/Work/modm-stm32f103c8t6-pb8` includes Debug-only RTT output, a global C++ debug struct, native DAP/HLA configurations and `tools/check-debug-workflow.py`. Validation uses Debug/Release builds, actual ARM GDB/MI struct children and a host-compiled RTT formatting/skip check. It does not flash or halt a board.

Official references: [modm RTT](https://modm.io/reference/module/modm-rtt/), [modm build](https://modm.io/reference/module/modm-build/), [OpenOCD adapter configuration](https://openocd.org/doc/html/Debug-Adapter-Configuration.html).
