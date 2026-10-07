#!/usr/bin/env python3
"""Run one command on a real pty and report what happened as JSON on stdout.

`team approve`'s paste guard reads the terminal the command's own standard input is attached
to, so proving it needs a caller that has one. `script(1)` is the usual trick, but the macOS
(BSD) dialect aborts when its own stdin is a socket - which is what a test runner's pipe is -
printing `script: tcgetattr/ioctl: Operation not supported on socket` and never running the
command. This driver does the same job with the same call: pty.fork() is forkpty(3), which
gives the child a new session, the pty slave as stdin/stdout/stderr and that slave as its
controlling terminal. It runs the same way on macOS and on Linux.

--no-ctty gives the child the slave on its standard streams but NO controlling terminal
(openpty + setsid, no TIOCSCTTY): the topology where /dev/tty is not the command's input, so a
guard that reads /dev/tty cannot see what is queued on the command's own terminal.

Usage: pty-run.py [--write TEXT] [--no-ctty] -- CMD [ARG...]

--write feeds TEXT to the pty (as if typed at it) before the child is read from. Everything
the pty produced, the echo of TEXT included, comes back as "out"; the exit status is "exit",
or "signal" when the child was killed. A 20 s deadline kills the child's session; "killed"
says whether that happened.
"""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

DEADLINE = 20.0


def drain(master, out, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        readable, _, _ = select.select([master], [], [], 0.05)
        if not readable:
            break
        try:
            chunk = os.read(master, 65536)
        except OSError:  # EIO: the slave side is fully closed
            break
        if not chunk:
            break
        out += chunk


def main():
    argv = sys.argv[1:]
    write = None
    no_ctty = False
    while argv and argv[0].startswith("--") and argv[0] != "--":
        if argv[0] == "--write":
            if len(argv) < 2:
                print("--write needs its text", file=sys.stderr)
                return 2
            write = argv[1].encode()
            argv = argv[2:]
        elif argv[0] == "--no-ctty":
            no_ctty = True
            argv = argv[1:]
        else:
            print(f"unknown option {argv[0]}", file=sys.stderr)
            return 2
    if not argv or argv[0] != "--" or len(argv) < 2:
        print("usage: pty-run.py [--write TEXT] [--no-ctty] -- CMD [ARG...]", file=sys.stderr)
        return 2
    command = argv[1:]

    if no_ctty:
        master, slave = pty.openpty()
        child = subprocess.Popen(
            command,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            # A new session WITHOUT a controlling terminal: no TIOCSCTTY, no setsid-from-tty.
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave)
        pid = child.pid
    else:
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.execvp(command[0], command)
            finally:
                os._exit(127)

    if write is not None:
        os.write(master, write)

    out = bytearray()
    killed = False
    status = None
    deadline = time.monotonic() + DEADLINE
    while True:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            out += chunk
        done, st = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = st
            drain(master, out, 1.0)
            break
        if time.monotonic() > deadline:
            killed = True
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
            status = os.waitpid(pid, 0)[1]
            drain(master, out, 1.0)
            break

    os.close(master)
    report = {"out": out.decode("utf-8", "replace"), "killed": killed}
    if status is not None and os.WIFEXITED(status):
        report["exit"] = os.WEXITSTATUS(status)
    elif status is not None and os.WIFSIGNALED(status):
        report["signal"] = os.WTERMSIG(status)
    else:
        report["exit"] = None
    json.dump(report, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
