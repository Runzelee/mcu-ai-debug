export interface StreamSink {
    prefix: string;
    write: (text: string) => boolean;
}
export function sendToStream(args: string, sinks: StreamSink[], emit: (message: object) => void): void {
    const names = () => sinks.map((sink) => sink.prefix);
    const fail = (message: string, error: string, extra: object = {}) =>
        emit({ source: "DA", level: "error", command: "send", error, message: `!!send: ${message}`, ...extra });
    const addressPart = args.trimStart();
    let addressed: string | undefined;
    let text: string;
    if (addressPart.startsWith("[")) {
        const end = addressPart.indexOf("]");
        if (end < 0) {
            fail(`unterminated stream name in '${addressPart}'`, "bad-prefix");
            return;
        }
        const prefix = addressPart.substring(0, end + 1);
        addressed = prefix === "[]" ? undefined : prefix;
        text = addressPart.substring(end + 1).replace(/^\s/, "");
    } else text = args;
    let target: StreamSink | undefined;
    if (addressed) {
        target = sinks.find((sink) => sink.prefix === addressed);
        if (!target) {
            fail(`no stream named ${addressed}. Known streams: ${names().join(", ") || "(none)"}`, "unknown-stream", {
                target: addressed,
                available: names(),
            });
            return;
        }
    } else if (sinks.length > 1) {
        fail(`more than one stream, name the one you mean: ${names().join(", ")}`, "ambiguous", { available: names() });
        return;
    } else target = sinks[0];
    if (!target) {
        fail("this session has no serial or RTT streams to send to", "no-streams", { available: [] });
        return;
    }
    if (!target.write(text)) {
        fail(`${target.prefix} is not connected`, "not-connected", { target: target.prefix });
        return;
    }
    emit({ source: "DA", command: "send", target: target.prefix, text, message: `${target.prefix} <= ${text}` });
}
