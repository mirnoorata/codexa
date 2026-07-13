from __future__ import annotations

import json
import os
import pathlib
import sys
import unittest


PROJECT = pathlib.Path("/workspace/project")


def main() -> int:
    try:
        result_fd = int(os.environ["CODEXA_RESULT_FD"])
    except (KeyError, ValueError):
        return 2

    sys.path.insert(0, str(PROJECT))
    try:
        suite = unittest.defaultTestLoader.discover(
            str(PROJECT / "tests"),
            pattern="test*.py",
        )
        with open(os.devnull, "w", encoding="utf-8") as diagnostics:
            result = unittest.TextTestRunner(stream=diagnostics, verbosity=0).run(suite)
    except Exception:
        return 3

    encoded = json.dumps(
        {
            "schemaVersion": 1,
            "successful": result.wasSuccessful() and result.testsRun > 0,
            "testsRun": result.testsRun,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    write_all(result_fd, encoded + b"\n")
    return 0


def write_all(descriptor: int, value: bytes) -> None:
    written = 0
    while written < len(value):
        count = os.write(descriptor, value[written:])
        if count <= 0:
            raise OSError("result channel closed before the payload was written")
        written += count


if __name__ == "__main__":
    raise SystemExit(main())
