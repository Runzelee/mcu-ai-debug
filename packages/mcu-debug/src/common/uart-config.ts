import * as path from "node:path";
import { SerialParams } from "@mcu-debug/shared/serial-helper/SerialParams";

/** Canonical Windows COM identifiers; POSIX paths keep their case and slashes. */
export function normalizeUartPath(value: string): string {
    const device = value.trim();
    const com = /^(?:\\\\\.\\)?(COM\d+)$/i.exec(device);
    return com ? com[1].toUpperCase() : device;
}
export const uartDeviceLabel = (device: string): string => path.win32.basename(normalizeUartPath(device));
export function uartParams(device: string, baud: number, input: "raw" | "cooked" = "cooked"): SerialParams {
    if (!Number.isInteger(baud) || baud <= 0 || baud > 4000000) throw new Error("Enter a baud rate between 1 and 4000000");
    const normalized = normalizeUartPath(device);
    if (!normalized) throw new Error("Enter a serial device path or COM port");
    return { path: normalized, label: uartDeviceLabel(normalized), baud_rate: baud, data_bits: 8,
        stop_bits: "one", parity: "none", flow_control: "none", transport: "direct", input_mode: input };
}
