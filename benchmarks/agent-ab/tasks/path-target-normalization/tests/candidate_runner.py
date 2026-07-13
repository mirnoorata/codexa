from __future__ import annotations

import importlib
import json
import os
import pathlib
import sys


PROJECT = pathlib.Path("/workspace/project")


def main() -> int:
    try:
        result_fd = int(os.environ["CODEXA_RESULT_FD"])
    except (KeyError, ValueError):
        return 2
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 2
    if set(payload) != {"schemaVersion", "cases"} or payload.get("schemaVersion") != 1:
        return 2
    cases = payload.get("cases")
    if not isinstance(cases, list) or any(
        type(case) is not list or any(type(value) is not str for value in case)
        for case in cases
    ):
        return 2

    sys.path.insert(0, str(PROJECT))
    importlib.invalidate_caches()
    try:
        module = importlib.import_module("src.targets")
        normalize_targets = module.normalize_targets
    except Exception:
        return 3
    if not callable(normalize_targets):
        return 3

    results: list[list[str]] = []
    try:
        for case in cases:
            result = normalize_targets(case)
            if type(result) is not list or any(type(value) is not str for value in result):
                return 4
            results.append(result)
    except Exception:
        return 4

    encoded = json.dumps(
        {"schemaVersion": 1, "results": results},
        ensure_ascii=False,
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
