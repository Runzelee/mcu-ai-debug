import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUartPath, uartDeviceLabel, uartParams } from "../common/uart-config";

test("UART configuration handles COM10 device syntax and POSIX paths without host-specific basename logic", () => {
    assert.equal(normalizeUartPath(' com10 '), 'COM10');
    assert.equal(normalizeUartPath('\\\\.\\COM12'), 'COM12');
    assert.equal(uartDeviceLabel('\\\\.\\COM12'), 'COM12');
    assert.equal(uartDeviceLabel('/dev/ttyACM0'), 'ttyACM0');
    assert.equal(normalizeUartPath('/dev/serial/by-id/USB-MixedCase'), '/dev/serial/by-id/USB-MixedCase');
    assert.deepEqual(uartParams('COM10', 115200), { path: 'COM10', label: 'COM10', baud_rate: 115200, data_bits: 8,
        stop_bits: 'one', parity: 'none', flow_control: 'none', transport: 'direct', input_mode: 'cooked' });
    assert.throws(() => uartParams('COM10', 0));
    assert.throws(() => uartParams('', 115200));
});
