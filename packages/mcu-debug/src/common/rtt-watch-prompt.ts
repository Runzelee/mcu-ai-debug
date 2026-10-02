/** JSON Lines protocol instructions copied explicitly by the user. */
export const JSON_WATCH_FIRMWARE_PROMPT = `Generate telemetry over RTT or UART as UTF-8 JSON Lines: one complete JSON object or array per line, ending in \\n. Supported forms:
{"motor":{"rpm":4000,"enabled":true},"temperatures":[32.5,33.1]}
motor_debug={"rpm":4000,"enabled":true,"error":null}

Nested objects/arrays, numbers, booleans, strings and null are supported. An optional name uses ASCII letters, digits, _, ., :, / or - and starts with a letter or _. Each line is a full snapshot: omitted fields disappear. Use valid JSON without extra log prefixes, multiline formatting, NaN, Infinity, hex numbers or trailing commas.

Reuse the project's existing RTT or UART setup; send each complete line through SEGGER_RTT_Write(channel, buffer, length) or the existing UART transmit API, preferably non-blocking.`;
