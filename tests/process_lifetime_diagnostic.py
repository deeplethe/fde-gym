"""Bounded CI diagnostics for the synthetic orphan/exec regression only."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'harness'))
import process_lifetime as lifetime

processes = lifetime._Processes()
def identity(pid):
    info = processes.identity(pid)
    if info is None:
        return None
    return {key: int(getattr(info, key)) for key in
            ('uniqueid', 'parent_uniqueid', 'version', 'original_parent_version')}

def state(pid):
    info = identity(pid)
    buf = (ctypes.c_uint32 * 32)()
    size = processes.lib.proc_pidinfo(pid, 13, 0, buf, ctypes.sizeof(buf))
    ps = subprocess.run(['/bin/ps', '-o', 'pid=,ppid=,stat=', '-p', str(pid)],
                        capture_output=True, text=True)
    return {'pid': pid, 'identity': info, 'native_pid_ppid_pgid_status': list(buf[:4]) if size >= 16 else None,
            'ps': ps.stdout.strip()}

print(json.dumps({'python': sys.version, 'macos': subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip(),
                  'observer': state(os.getpid())}), flush=True)
original_cleanup = lifetime._Family.cleanup
observations = []
marker = None
def cleanup(family):
    try:
        return original_cleanup(family)
    finally:
        if marker is not None and marker.exists():
            observations.append({'family_members': family.members, 'family_ids': sorted(family.ids),
                                 'family_versions': sorted(family.versions), 'child': state(int(marker.read_text()))})
lifetime._Family.cleanup = cleanup

for attempt in range(100):
    observations.clear()
    with tempfile.TemporaryDirectory(prefix='fde-lifetime-diag-', dir='/tmp') as directory:
        marker = Path(directory, 'child.pid')
        child = ("import os,sys,time\nparent=os.getppid()\n"
                 "while os.getppid()==parent: time.sleep(.001)\n"
                 "os.execv(sys.executable,[sys.executable,'-c','import time; time.sleep(10)'])")
        code = ("import subprocess,sys\n"
                "p=subprocess.Popen([sys.executable,'-c',%r],start_new_session=True,"
                "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
                "open('child.pid','w').write(str(p.pid))\n") % child
        try:
            lifetime.run_delivered([sys.executable, '-c', code], cwd=directory, timeout=3)
            pid = int(marker.read_text())
            result = state(pid)
            live = bool(result['ps']) and not result['ps'].split()[-1].startswith('Z')
            if live:
                print(json.dumps({'attempt': attempt + 1, 'live_child_after_return': True,
                                  'observations': observations, 'final': result}), flush=True)
                sys.exit(1)
        finally:
            if marker.exists():
                try:
                    os.kill(int(marker.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
print(json.dumps({'attempts': 100, 'live_child_after_return': False}), flush=True)
