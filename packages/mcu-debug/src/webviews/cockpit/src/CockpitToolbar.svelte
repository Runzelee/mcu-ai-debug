<!--
// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
    import type { CockpitSessionMode, CockpitToolbarAction, CockpitUiState } from "@mcu-debug/shared";

    type ToolbarActionItem = {
        action: CockpitToolbarAction;
        label: string;
        tooltip: string;
        codicon?: string;
        useResetIcon?: boolean;
        accent?: "success" | "danger" | "warning" | "pause";
    };

    const {
        state,
        onAction,
        onConfigSelect,
        onModeSelect,
    }: {
        state: CockpitUiState;
        onAction: (action: CockpitToolbarAction) => void;
        onConfigSelect: (configName: string) => void;
        onModeSelect: (mode: CockpitSessionMode) => void;
    } = $props();

    const resetIconUri = typeof document !== "undefined" ? document.body.dataset.resetIcon ?? "" : "";

    const primaryActions: Record<"continue" | "pause", ToolbarActionItem> = {
        continue: { action: "continue", label: "Continue", tooltip: "Continue", codicon: "debug-continue", accent: "success" },
        pause: { action: "pause", label: "Pause", tooltip: "Pause", codicon: "debug-pause", accent: "pause" },
    };

    const secondaryActions: ToolbarActionItem[] = [
        { action: "step-over", label: "Step Over", tooltip: "Step Over", codicon: "debug-step-over" },
        { action: "step-into", label: "Step Into", tooltip: "Step Into", codicon: "debug-step-into" },
        { action: "step-out", label: "Step Out", tooltip: "Step Out", codicon: "debug-step-out" },
        { action: "restart", label: "Restart", tooltip: "Restart Session", codicon: "debug-restart" },
        { action: "reset", label: "Reset", tooltip: "Reset Device", useResetIcon: true, accent: "warning" },
        { action: "stop", label: "Stop", tooltip: "Stop", codicon: "debug-stop", accent: "danger" },
    ];

    function getPrimaryAction(state: CockpitUiState): ToolbarActionItem {
        return state.statusText.toLowerCase().startsWith("running") ? primaryActions.pause : primaryActions.continue;
    }

    function handleSelect(event: Event) {
        const target = event.currentTarget as HTMLSelectElement;
        if (target.value) {
            onConfigSelect(target.value);
        }
    }

    const primaryAction = $derived(getPrimaryAction(state));
</script>

<div class="toolbar">
    <div class="buttons" role="toolbar" aria-label="AI cockpit debug controls">
        <button
            class={`tool-button primary-button ${primaryAction.accent ? `accent-${primaryAction.accent}` : ""}`}
            type="button"
            title={primaryAction.tooltip}
            aria-label={primaryAction.label}
            disabled={!state.buttonEnabled[primaryAction.action]}
            onclick={() => onAction(primaryAction.action)}
        >
            <span class={`codicon codicon-${primaryAction.codicon ?? "circle-large-outline"}`} aria-hidden="true"></span>
        </button>

        {#each secondaryActions as item (item.action)}
            <button
                class={`tool-button ${item.accent ? `accent-${item.accent}` : ""}`}
                type="button"
                title={item.tooltip}
                aria-label={item.label}
                disabled={!state.buttonEnabled[item.action]}
                onclick={() => onAction(item.action)}
            >
                {#if item.useResetIcon}
                    <img class="reset-icon" src={resetIconUri} alt="" aria-hidden="true" />
                {:else}
                    <span class={`codicon codicon-${item.codicon ?? "circle-large-outline"}`} aria-hidden="true"></span>
                {/if}
            </button>
        {/each}
    </div>

    <label class="mode-picker">
        <span class="config-label">Mode</span>
        <span class="select-control">
        <select
            aria-label="AI Cockpit session mode"
            value={state.sessionMode}
            disabled={state.modeLocked}
            title={state.modeLocked ? "Stop the independent session before changing modes" : "Choose how to start the debug session"}
            onchange={(event) => onModeSelect(event.currentTarget.value as CockpitSessionMode)}
        >
            <option value="current">Follow VS Code Debug</option>
            <option value="independent">Independent GDB Session</option>
        </select>
        <span class="codicon codicon-chevron-down select-arrow" aria-hidden="true"></span>
        </span>
    </label>

    <label class="config-picker">
        <span class="config-label">Config</span>
        <span class="select-control">
        <select aria-label="Debug configuration" title={state.selectedConfig ?? "No mcu-debug configurations"} value={state.selectedConfig ?? ""} onchange={handleSelect}>
            {#if state.availableConfigs.length === 0}
                <option value="">No mcu-debug configurations</option>
            {:else}
                {#each state.availableConfigs as configName (configName)}
                    <option value={configName}>{configName}</option>
                {/each}
            {/if}
        </select>
        <span class="codicon codicon-chevron-down select-arrow" aria-hidden="true"></span>
        </span>
    </label>

    <div class="status" aria-live="polite">{state.statusText}</div>
</div>

<style>
    .toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 3px 10px;
        border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
        background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
        flex-shrink: 0;
        min-height: 34px;
        flex-wrap: wrap;
    }

    .buttons {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
    }

    .tool-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-icon-foreground, var(--vscode-editor-foreground, #d4d4d4));
        cursor: pointer;
    }

    .tool-button:hover:not(:disabled) {
        background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        border-color: var(--vscode-toolbar-hoverOutline, transparent);
    }

    .tool-button.accent-success {
        color: var(--vscode-debugIcon-continueForeground, var(--vscode-terminal-ansiGreen, #89d185));
    }

    .tool-button.accent-danger {
        color: var(--vscode-debugIcon-stopForeground, var(--vscode-errorForeground, #f14c4c));
    }

    .tool-button.accent-warning {
        color: var(--vscode-charts-orange, #e8a000);
    }

    .tool-button.accent-pause {
        color: var(--vscode-debugIcon-pauseForeground, var(--vscode-charts-blue, #3794ff));
    }

    .tool-button:disabled {
        opacity: 0.45;
        cursor: default;
        color: var(--vscode-disabledForeground, #7f7f7f);
    }

    .tool-button :global(.codicon) {
        font-size: 16px;
    }

    .reset-icon {
        width: 16px;
        height: 16px;
        object-fit: contain;
    }

    .tool-button:disabled .reset-icon {
        opacity: 0.55;
    }

    .config-picker, .mode-picker {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        margin-block: 1px;
    }

    .config-label {
        color: var(--vscode-descriptionForeground, #9d9d9d);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .select-control {
        position: relative;
        display: inline-flex;
        min-width: 0;
        max-width: min(280px, 55vw);
    }

    .select-arrow {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 16px;
        font-size: 16px;
        color: var(--vscode-dropdown-foreground, #f0f0f0);
        pointer-events: none;
    }

    select {
        appearance: none;
        box-sizing: border-box;
        min-width: 100px;
        max-width: 100%;
        height: 24px;
        border: 1px solid var(--vscode-dropdown-border, transparent);
        background: var(--vscode-dropdown-background, #3c3c3c);
        color: var(--vscode-dropdown-foreground, #f0f0f0);
        border-radius: 4px;
        padding: 0 32px 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: inherit;
        font-size: 12px;
        line-height: 1.2;
    }

    select:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, #007fd4);
        outline-offset: 1px;
    }

    .status {
        margin-left: auto;
        color: var(--vscode-descriptionForeground, #9d9d9d);
        font-size: 12px;
        white-space: nowrap;
    }

    .mode-picker select {
        width: 180px;
    }
</style>
