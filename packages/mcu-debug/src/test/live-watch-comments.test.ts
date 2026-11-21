import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionContext, InputBoxOptions } from "vscode";

// Only the extension host normally provides this module. Stub the small part of
// its API needed to exercise the actual provider with no connected debugger.
export class EventEmitter {}
export const TreeItemCollapsibleState = { Collapsed: 1 };
export const workspace = {
    getConfiguration: () => ({ get: (_key: string, fallback: number) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
};
export const window = {
    showInputBox: async (_options: InputBoxOptions): Promise<string | undefined> => undefined,
};

test("GDB watch comments round-trip in a legacy workspace independently of expressions and values", async (t) => {
    const hook = registerHooks({
        resolve(specifier, context, next) {
            return next(specifier === "vscode" ? pathToFileURL(__filename).href : specifier, context);
        },
    });
    t.after(() => hook.deregister());
    const { LiveWatchTreeProvider } = require("../frontend/views/live-watch") as typeof import("../frontend/views/live-watch");
    const expression = "sensor.reading";
    const entry = { name: expression, expr: expression, expanded: false, children: [] };
    const storage = new Map<string, unknown>([
        ["livewatch.version", 2],
        ["livewatch.watchTree", { name: "", expr: "", expanded: true, children: [entry] }],
    ]);
    const context = {
        subscriptions: [],
        workspaceState: {
            get: (key: string) => storage.get(key),
            update: async (key: string, value: unknown) => {
                await new Promise<void>((resolve) => setImmediate(resolve));
                storage.set(key, JSON.parse(JSON.stringify(value)));
            },
        },
    } as unknown as ExtensionContext;
    const provider = new LiveWatchTreeProvider(context);
    const [original] = await provider.getChildren();
    const text = "角速度（°/秒） <sensor> & Δ";
    const input = t.mock.method(window, "showInputBox", async () => text);
    await provider.onEditComment(original.id);
    const restored = new LiveWatchTreeProvider(context);
    const updates: (string | undefined)[] = [];
    restored.setUpdateItemsCallback((items) => updates.push(...items.map((item) => item.comment)));
    const [watch] = await restored.getChildren();
    assert.equal(watch.comment, text);
    assert.equal(watch.label, expression);
    assert.equal(watch.value, original.value);

    input.mock.mockImplementation(async () => undefined);
    await restored.onEditComment(watch.id);
    assert.equal(input.mock.calls.at(-1)?.arguments[0]?.value, text);
    assert.equal((await restored.getChildren())[0].comment, text);
    assert.deepEqual(updates, []);

    input.mock.mockImplementation(async () => "");
    await restored.onEditComment(watch.id);
    assert.deepEqual(updates, [""]);
    const [cleared] = await new LiveWatchTreeProvider(context).getChildren();
    assert.equal(cleared.comment, "");
    assert.equal(cleared.label, expression);
});
