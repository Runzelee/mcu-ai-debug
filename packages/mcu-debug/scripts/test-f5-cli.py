#!/usr/bin/env python3
"""Two isolated Linux VS Code instances, inline mock DAP and TCP RTT; no target hardware."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--code', default='/usr/share/code/code')
parser.add_argument('--extensions-dir', default=str(Path.home() / '.vscode/extensions'))
parser.add_argument('--base', type=Path)
parser.add_argument('--elf', default='/bin/true')
parser.add_argument('--visual', action='store_true', help='Capture real isolated Electron UI and click Start/Stop (instance A).')
args = parser.parse_args()
extension = Path(__file__).resolve().parents[1]
base = args.base or Path(tempfile.mkdtemp(prefix='mcu-ai-f5-smoke-'))
base.mkdir(parents=True, exist_ok=True)
for result in base.glob('*-?.json'):
    result.unlink()
workspace = base / 'workspace'
(workspace / '.vscode').mkdir(parents=True, exist_ok=True)
(workspace / '.vscode/settings.json').write_text(json.dumps({'mcu-debug.enableTelemetry': False, 'mcu-ai-debug.enableMcp': False}))
(workspace / '.vscode/launch.json').write_text(json.dumps({'version': '0.2.0', 'configurations': [{
    'name': 'Independent smoke', 'type': 'mcu-debug', 'request': 'attach', 'servertype': 'external',
    'gdbTarget': '127.0.0.1:3333', 'cwd': '${workspaceFolder}', 'executable': args.elf,
}]}))
# Distinct display numbers prevent concurrent xvfb-run -a startup/cleanup races.
displays = [number for number in range(180, 240) if not Path(f'/tmp/.X{number}-lock').exists()][:2]
if len(displays) != 2:
    raise SystemExit('No free test X displays')
processes = []
try:
    for instance, display in zip(('A', 'B'), displays):
        env = {key: value for key, value in os.environ.items() if not key.startswith('VSCODE_') and key != 'ELECTRON_RUN_AS_NODE'}
        env.update(MCU_SMOKE_INSTANCE=instance, MCU_AI_SMOKE_BASE=str(base), MCU_AI_SMOKE_ELF=args.elf)
        debugging = []
        if args.visual and instance == 'A':
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            env['MCU_AI_VISUAL_PORT'] = str(port)
            debugging = ['--remote-debugging-port=' + str(port)]
        command = ['xvfb-run', '-n', str(display), args.code, '--ozone-platform=x11', '--disable-gpu',
                   '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
                   '--user-data-dir', str(base / f'profile-{instance}'), '--extensions-dir', args.extensions_dir,
                   '--extensionDevelopmentPath=' + str(extension),
                   '--extensionTestsPath=' + str(extension / 'src/test/f5-cli.smoke.cjs'), *debugging, str(workspace)]
        log = (base / f'run-{instance}.log').open('w')
        processes.append((instance, subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True), log))
    failed = False
    for instance, process, log in processes:
        try:
            code = process.wait(timeout=100)
        except subprocess.TimeoutExpired:
            code = 124
        result = base / f'checked-{instance}.json'
        if code or not result.exists():
            failed = True
            print(f'{instance}: FAIL ({code}); see {base / ("run-" + instance + ".log")}')
        else:
            print(json.dumps(json.loads(result.read_text())))
    print(f'Evidence: {base}')
    if failed:
        raise SystemExit(1)
finally:
    for _, process, log in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        log.close()
