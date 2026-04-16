# MCU-Debug MCP Tool Reference

> **If you are an AI assistant reading this file: STOP. Do NOT browse the MCU-Debug source code or write any Python/Node.js scripts to read debug variables. You already have direct native MCP tools. Use them.**

## Overview

You have access to the following MCP tools. They are already wired into the running VS Code debug session. Call them directly.

---

### Tool: `get_livewatch_variables`
**Purpose**: Returns a snapshot of ALL currently-watched C/C++ variables and their real-time values from the target MCU.

**Input**: None.

**Output** (JSON):
| status | Description |
|---|---|
| `"OK"` | Success. The `variables` field contains `{ "expression": "value" }` pairs. If any value is `"<STRUCT_OR_ARRAY_UNEXPANDED>"`, that variable is a struct/array that must be expanded via `expand_livewatch_struct` before its children become readable. |
| `"NO_DEBUG_SESSION"` | No active debug session. Tell the user to start debugging (F5). Do NOT try to work around this. |
| `"NO_VARIABLES"` | Debug session is active but the Live Watch panel is empty. Use `add_livewatch_variable` to add variables, or ask the user. |
| `"ERROR"` | An unexpected error occurred. The `error` field contains details. |

---

### Tool: `add_livewatch_variable`
**Purpose**: Adds a C/C++ expression to the Live Watch panel so it gets polled from the MCU in real-time.

**Input**: `{ "expr": "g_motor.speed" }` — any valid C expression that GDB can evaluate.

**Output** (JSON):
| status | Description |
|---|---|
| `"OK"` | Success. The `expression` field contains the added expression. |
| `"NO_DEBUG_SESSION"` | No active debug session. |
| `"ERROR"` | Failed to add. The `error` field contains details (e.g., invalid expression). |

---

### Tool: `expand_livewatch_struct`
**Purpose**: Expands an unexpanded struct or array in the Live Watch to reveal its children/members.

**Input**: `{ "expr": "g_motor" }` — the exact expression string as shown in `get_livewatch_variables`.

**Output** (JSON):
| status | Description |
|---|---|
| `"OK"` | Expansion succeeded. Call `get_livewatch_variables` again to see the new children. |
| `"NO_DEBUG_SESSION"` | No active debug session. |
| `"NOT_FOUND"` | The expression was not found in the Live Watch panel. Check the exact spelling. |
| `"NOT_EXPANDABLE"` | The expression is a leaf variable (scalar), not a struct/array. It cannot be expanded. |
| `"ERROR"` | An unexpected error during expansion. The `error` field contains details. |

---

### Tool: `record_livewatch_variables`
**Purpose**: Automatically records Live Watch values for a fixed duration and returns a timeseries data table.

**Input**: `{ "duration_ms": 5000 }` — duration in milliseconds. Will be capped to the user's configured maximum (default: 30s).

**Output** (JSON):
| status | Description |
|---|---|
| `"OK"` | Recording completed. `duration_ms`, `sample_count`, and `records` (array of `{ time, values }`) are present. |
| `"NO_DEBUG_SESSION"` | No active debug session. |
| `"NO_VARIABLES"` | No leaf variables are available to record. Add or expand variables first. |
| `"MANUAL_MODE_REQUIRED"` | The user has enabled manual recording mode. You **must** use the `record_livewatch_variables_manual` tool instead. Do NOT ask the user — just switch tools. |
| `"CANCELLED_OR_EMPTY"` | The user cancelled via the notification, or no data was captured. `records` will be an empty array. |
| `"ERROR"` | Invalid input or unexpected error. The `error` field contains details. |

---

### Tool: `record_livewatch_variables_manual`
**Purpose**: Records Live Watch values with **manual user-controlled start and stop**. The user clicks "Start" and "Stop" buttons inside VS Code. This tool requires NO input parameters.

**Input**: None.

**Important behavior**:
- This tool will **block for a long time** while waiting for the user to physically interact with their hardware and click buttons. This is completely normal. Do NOT abort or time out early.
- The maximum wall-clock time is controlled by the user's `mcu-ai-debug.mcpManualRecordingMaxDuration` setting (default: 60s).

**Output** (JSON):
| status | Description |
|---|---|
| `"OK"` | Recording completed. `end_reason` is `"USER_STOPPED"` or `"MAX_DURATION_REACHED"`. `sample_count` and `records` are present. |
| `"NO_DEBUG_SESSION"` | No active debug session. |
| `"NO_VARIABLES"` | No leaf variables are available to record. |
| `"CANCELLED_BY_USER"` | The user clicked "Cancel" or dismissed the Start prompt. Do NOT retry aggressively. Politely inform the user and wait. |
| `"CANCELLED_OR_EMPTY"` | Recording started but produced no data (e.g., debug session ended mid-recording). |

---

## CRITICAL RULES FOR AI AGENTS

1. **DO NOT** write Python scripts, Node.js scripts, or any other code to read debug variables. The MCP tools handle everything.
2. **DO NOT** try to parse GDB output, memory dumps, or ELF files to get variable values.
3. **DO NOT** look through the MCU-Debug extension source code trying to understand "how to connect". You are ALREADY connected via MCP.
4. **DO NOT** ask the user "how should I read the variables?" — just call `get_livewatch_variables`.
5. If you see `"<STRUCT_OR_ARRAY_UNEXPANDED>"` in any variable value, call `expand_livewatch_struct` on that expression immediately.
6. If you get `"NO_DEBUG_SESSION"`, tell the user: "Please start a debug session (F5) and I'll read the variables for you."
7. If you need a variable that isn't being watched, call `add_livewatch_variable` to add it, wait a moment, then call `get_livewatch_variables` again.
8. If `record_livewatch_variables` returns `"MANUAL_MODE_REQUIRED"`, switch to `record_livewatch_variables_manual` without asking the user.
9. If `record_livewatch_variables_manual` returns `"CANCELLED_BY_USER"`, do NOT retry automatically. Inform the user politely and wait.

## For Humans: Setup Instructions

This project has MCU-Debug MCP integration configured. To use it with your AI assistant:

- **VS Code**: The `.vscode/mcp.json` file is already set up. Your AI agent will automatically discover the MCU-Debug tools.
- **Antigravity**: Go to Open Antigravity User Settings, click "Open MCP Config", and paste the contents of `.vscode/mcu-debug-mcp.json`.
- **Cursor**: Go to Settings > Features > MCP, click "Add New MCP Server", and paste the contents of `.vscode/mcu-debug-mcp.json`.
- **Claude Desktop / Other**: Copy the contents of `.vscode/mcu-debug-mcp.json` into your client's MCP configuration file.

## VS Code Settings Reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `mcu-ai-debug.mcpRequireManualRecording` | boolean | false | If enabled, `record_livewatch_variables` returns `MANUAL_MODE_REQUIRED` and agents must use the manual tool. |
| `mcu-ai-debug.mcpRecordingMaxDuration` | number | 30 | Max recording duration in seconds for automatic mode. |
| `mcu-ai-debug.mcpManualRecordingMaxDuration` | number | 60 | Max recording duration in seconds for manual mode. |
