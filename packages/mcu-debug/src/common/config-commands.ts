/** Resolve command variables before handing a VS Code configuration to the CLI. */
export async function resolveConfigurationCommands<T>(
    configuration: T,
    executeCommand: (command: string, configuration: T) => Promise<unknown>,
): Promise<T> {
    const results = new Map<string, Promise<string>>();
    const resolveValue = async (value: any): Promise<any> => {
        if (typeof value === "string") {
            const references = [...value.matchAll(/\$\{command:([^}]+)\}/g)];
            let output = "";
            let offset = 0;
            for (const reference of references) {
                const command = reference[1];
                if (!results.has(command)) {
                    results.set(command, executeCommand(command, configuration).then((result) => {
                        if (typeof result !== "string") {
                            throw new Error(`Command variable ${reference[0]} did not return a string.`);
                        }
                        return result;
                    }));
                }
                // Command results stay literal, including '$' and backslashes.
                output += value.slice(offset, reference.index) + await results.get(reference[1]);
                offset = reference.index! + reference[0].length;
            }
            return output + value.slice(offset);
        }
        if (Array.isArray(value)) {
            const resolved = [];
            for (const item of value) {
                resolved.push(await resolveValue(item));
            }
            return resolved;
        }
        if (value !== null && typeof value === "object") {
            const resolved: Record<string, any> = {};
            for (const [key, item] of Object.entries(value)) {
                resolved[key] = await resolveValue(item);
            }
            return resolved;
        }
        return value;
    };
    return resolveValue(configuration);
}
