"""Hold one explicitly owned test child, then exec the unchanged target PID."""
import json
import os
from pathlib import Path
import stat
import sys
import time


def main():
    directory, nonce, parent, target = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4]
    before = directory.lstat()
    if (directory.resolve() != directory or not stat.S_ISDIR(before.st_mode)
            or before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o700
            or os.getpid() != os.getpgrp() or os.getpid() != os.getsid(0)):
        raise ValueError()
    deadline = time.monotonic() + 30
    release = directory / 'release.json'
    while os.getppid() == parent and time.monotonic() < deadline:
        try:
            fd = os.open(release, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            time.sleep(.01)
            continue
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 128:
                raise ValueError()
            data = os.read(fd, 129)
        finally:
            os.close(fd)
        current = directory.lstat()
        if ((current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
                or json.loads(data) != {'nonce': nonce}):
            raise ValueError()
        os.execvpe(target, sys.argv[5:], os.environ)
    raise ValueError()


try:
    main()
except BaseException:
    os.write(2, b'test-process-gate-refused\n')
    sys.exit(74)
