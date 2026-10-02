#!/usr/bin/env python3
"""Regression: helper discovers qualified C++ globals, including scopes after the first symbol."""
from pathlib import Path
import argparse
import json
import select
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--elf', type=Path, required=True)
parser.add_argument('--helper', type=Path, default=Path(__file__).resolve().parents[1]/'bin/linux-x64/mdbg')
parser.add_argument('--expect', action='append', default=[])
args = parser.parse_args()
expected = set(args.expect or ['app::pb8_debug', 'SystemCoreClock', 'modm::platform::delay_fcpu_MHz'])
process = subprocess.Popen([str(args.helper), 'da-helper', '--objdump-path', '/usr/bin/arm-none-eabi-objdump',
    '--rtt-search', str(args.elf)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
try:
    request = json.dumps({'req':'globals', 'seq':1}).encode()
    process.stdin.write(b'Content-Length: '+str(len(request)).encode()+b'\r\n\r\n'+request)
    process.stdin.flush()
    buffer = b''
    end = time.monotonic()+10
    result = None
    rtt = None
    while result is None or rtt is None:
        if time.monotonic() > end:
            raise TimeoutError('Symbol helper did not respond')
        if not select.select([process.stdout], [], [], 1)[0]:
            continue
        chunk = process.stdout.read1(65536)
        if not chunk:
            raise RuntimeError('Symbol helper exited before response')
        buffer += chunk
        while b'\r\n\r\n' in buffer:
            header, body = buffer.split(b'\r\n\r\n', 1)
            size = int(header.split(b':', 1)[1])
            if len(body) < size:
                break
            message = json.loads(body[:size])
            buffer = body[size:]
            if message.get('req') == 'globals':
                result = message['globals']
            if message.get('args', {}).get('type') == 'RTTFound':
                rtt = message['args']['address']
    names = {name for name, _ in result}
    assert expected <= names, f'Missing globals: {expected-names}; found {sorted(names)}'
    assert len(result) == len({(name,address) for name,address in result}), 'Duplicate global declarations'
    assert int(rtt, 16) > 0
    print(json.dumps({'globals':result, 'rttAddress':rtt, 'required':sorted(expected), 'hardware':False}))
finally:
    process.terminate()
    process.wait(timeout=5)
