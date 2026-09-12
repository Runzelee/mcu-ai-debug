export function parseBatchExpressions(value: string): string[] {
    const expressions: string[] = [];
    const seen = new Set<string>();

    for (const line of value.split(/\r?\n/)) {
        const expression = line.trim();
        if (expression && !seen.has(expression)) {
            seen.add(expression);
            expressions.push(expression);
        }
    }

    return expressions;
}
