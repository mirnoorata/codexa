from __future__ import annotations

import ctypes
import difflib
import json
import os
import pathlib
import random
import resource
import signal
import stat
import subprocess
import tempfile


PROJECT = pathlib.Path("/workspace/project")
PRISTINE = pathlib.Path("/opt/pristine-project")
CANDIDATE_RUNNER = pathlib.Path("/opt/codexa-agent-ab/candidate_runner.py")
PUBLIC_TEST_RUNNER = pathlib.Path("/opt/codexa-agent-ab/public_test_runner.py")
REWARD = pathlib.Path("/logs/verifier/reward.json")
CANDIDATE_UID = 65532
CANDIDATE_GID = 65532
ALLOWED_CHANGED_PATHS = {"src/targets.py", "tests/test_targets.py"}
IGNORED_PARTS = {".git", ".codex", "__pycache__"}
MAX_TREE_FILE_BYTES = 4 * 1024 * 1024
MAX_TREE_BYTES = 32 * 1024 * 1024
MAX_CANDIDATE_OUTPUT_BYTES = 128 * 1024
CANDIDATE_TIMEOUT_SECONDS = 8


def main() -> None:
    remove_stale_reward()
    scope, changed_files, changed_lines, before = verify_tree()
    lock_candidate_tree(PROJECT)
    try:
        locked = read_tree(PROJECT)
    except OSError:
        locked = {}
        scope = False
    if locked != before:
        scope = False

    behavior_cases = [
        ([" beta/file.py ", "alpha/file.py", "beta/file.py"], ["beta/file.py", "alpha/file.py"]),
        (["", "  ", "valid/file.py"], ["valid/file.py"]),
        (["/absolute.py", "../parent.py", "safe/../escape.py", "safe/file.py"], ["safe/file.py"]),
        (["C:/drive.py", "C:\\drive.py", "\\\\server\\share.py", "safe\\file.py"], []),
        (["safe/line\nfeed.py", "safe/tab\tname.py", "safe/delete\x7fname.py"], []),
    ]
    regression_cases = [
        ([" src/main.py ", "tests/test_main.py", "src/main.py"], ["src/main.py", "tests/test_main.py"]),
        (["", "  ", "src/main.py"], ["src/main.py"]),
        (["zeta/file.py", "alpha/file.py", "zeta/file.py"], ["zeta/file.py", "alpha/file.py"]),
        (["pkg/.../file.py", "pkg/..config", "pkg/../escape.py"], ["pkg/.../file.py", "pkg/..config"]),
    ]
    generated_cases = make_generated_cases()
    groups = [behavior_cases, regression_cases, generated_cases]
    all_cases = [case for group in groups for case in group]
    results = run_candidate([values for values, _expected in all_cases]) if scope else None
    offsets = [0, len(behavior_cases), len(behavior_cases) + len(regression_cases), len(all_cases)]
    behavior = verify_results(results, behavior_cases, offsets[0], offsets[1])
    regression = verify_results(results, regression_cases, offsets[1], offsets[2])
    genericity = verify_results(results, generated_cases, offsets[2], offsets[3])
    public_tests = run_public_tests() if scope else False

    try:
        after = read_tree(PROJECT)
    except OSError:
        after = {}
    scope = scope and after == locked
    reward_tampered = os.path.lexists(REWARD)
    verified = int(all((behavior, regression, scope, genericity, public_tests)) and not reward_tampered)
    rewards = {
        "verified_completion": verified,
        "behavior": int(behavior),
        "regression": int(regression),
        "scope": int(scope),
        "genericity": int(genericity),
        "public_tests": int(public_tests),
        "changed_files": changed_files,
        "changed_lines": changed_lines,
    }
    quarantine_untrusted_reward()
    write_reward(rewards)


def make_generated_cases() -> list[tuple[list[str], list[str]]]:
    rng = random.Random(73021)
    cases: list[tuple[list[str], list[str]]] = []
    for _ in range(40):
        left = f"pkg_{rng.randrange(10_000)}/mod_{rng.randrange(10_000)}.py"
        right = f"tests_{rng.randrange(10_000)}/test_{rng.randrange(10_000)}.py"
        values = [f" {left} ", right, left, f"../{rng.randrange(10_000)}.py", f"{left}/../escape.py"]
        cases.append((values, [left, right]))
    return cases


def run_candidate(cases: list[list[str]]) -> list[list[str]] | None:
    payload = json.dumps({"schemaVersion": 1, "cases": cases}, separators=(",", ":")).encode("utf-8")
    with tempfile.TemporaryFile() as protocol, tempfile.TemporaryFile() as diagnostics:
        environment = {
            "CODEXA_RESULT_FD": str(protocol.fileno()),
            "HOME": "/tmp/codexa-candidate",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "TMPDIR": "/tmp/codexa-candidate",
        }
        process = subprocess.Popen(
            ["python3", "-I", "-B", "-X", "pycache_prefix=/opt/codexa-agent-ab/empty-pycache/hidden", str(CANDIDATE_RUNNER)],
            cwd=PROJECT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=diagnostics,
            stderr=subprocess.STDOUT,
            pass_fds=(protocol.fileno(),),
            start_new_session=True,
            preexec_fn=confine_candidate,
        )
        try:
            process.communicate(input=payload, timeout=CANDIDATE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            kill_process_group(process.pid)
            process.wait()
            return None
        finally:
            kill_process_group(process.pid)
        if process.returncode != 0:
            return None
        protocol.seek(0)
        raw = protocol.read(MAX_CANDIDATE_OUTPUT_BYTES + 1)
    if len(raw) > MAX_CANDIDATE_OUTPUT_BYTES:
        return None
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict) or set(decoded) != {"schemaVersion", "results"} or decoded.get("schemaVersion") != 1:
        return None
    results = decoded.get("results")
    if type(results) is not list or len(results) != len(cases):
        return None
    if any(type(result) is not list or any(type(value) is not str for value in result) for result in results):
        return None
    return results


def run_public_tests() -> bool:
    with tempfile.TemporaryFile() as protocol, tempfile.TemporaryFile() as diagnostics:
        environment = {
            "CODEXA_RESULT_FD": str(protocol.fileno()),
            "HOME": "/tmp/codexa-candidate",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "TMPDIR": "/tmp/codexa-candidate",
        }
        process = subprocess.Popen(
            ["python3", "-I", "-B", "-X", "pycache_prefix=/opt/codexa-agent-ab/empty-pycache/public", str(PUBLIC_TEST_RUNNER)],
            cwd=PROJECT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=diagnostics,
            stderr=subprocess.STDOUT,
            pass_fds=(protocol.fileno(),),
            start_new_session=True,
            preexec_fn=confine_candidate,
        )
        try:
            process.wait(timeout=CANDIDATE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            kill_process_group(process.pid)
            process.wait()
            return False
        finally:
            kill_process_group(process.pid)
        if process.returncode != 0:
            return False
        protocol.seek(0)
        raw = protocol.read(MAX_CANDIDATE_OUTPUT_BYTES + 1)
    if len(raw) > MAX_CANDIDATE_OUTPUT_BYTES:
        return False
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(decoded, dict)
        and set(decoded) == {"schemaVersion", "successful", "testsRun"}
        and decoded.get("schemaVersion") == 1
        and decoded.get("successful") is True
        and type(decoded.get("testsRun")) is int
        and decoded["testsRun"] > 0
    )


def confine_candidate() -> None:
    set_no_new_privileges()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (5, 6))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_CANDIDATE_OUTPUT_BYTES, MAX_CANDIDATE_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    os.umask(0o077)
    os.setgroups([])
    os.setgid(CANDIDATE_GID)
    os.setuid(CANDIDATE_UID)


def set_no_new_privileges() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def kill_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def verify_results(
    results: list[list[str]] | None,
    cases: list[tuple[list[str], list[str]]],
    start: int,
    end: int,
) -> bool:
    if results is None or end - start != len(cases):
        return False
    selected = results[start:end]
    return all(
        type(actual) is list
        and all(type(value) is str for value in actual)
        and actual == expected
        for actual, (_values, expected) in zip(selected, cases, strict=True)
    )


def verify_tree() -> tuple[bool, int, int, dict[str, tuple[str, bytes]]]:
    try:
        baseline = read_tree(PRISTINE)
        candidate = read_tree(PROJECT)
    except OSError:
        return False, 0, 0, {}
    changed = sorted(path for path in baseline.keys() | candidate.keys() if baseline.get(path) != candidate.get(path))
    public_test = "tests/test_targets.py"
    baseline_test = baseline.get(public_test)
    candidate_test = candidate.get(public_test)
    tests_preserved = (
        baseline_test is not None
        and candidate_test is not None
        and candidate_test[0] == "file"
        and candidate_test[1].startswith(baseline_test[1])
    )
    scope_ok = (
        bool(changed)
        and all(path in ALLOWED_CHANGED_PATHS for path in changed)
        and all(candidate.get(path, (None, b""))[0] == "file" for path in changed)
        and tests_preserved
    )
    changed_lines = sum(count_changed_lines(baseline.get(path), candidate.get(path)) for path in changed)
    return scope_ok, len(changed), changed_lines, candidate


def read_tree(root: pathlib.Path) -> dict[str, tuple[str, bytes]]:
    entries: dict[str, tuple[str, bytes]] = {}
    total_bytes = 0
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        directory_path = pathlib.Path(directory)
        names[:] = sorted(name for name in names if name not in IGNORED_PARTS)
        for name in sorted(files):
            target = directory_path / name
            relative = target.relative_to(root)
            if any(part in IGNORED_PARTS for part in relative.parts) or target.suffix == ".pyc":
                continue
            key = relative.as_posix()
            metadata = os.lstat(target)
            if stat.S_ISLNK(metadata.st_mode):
                entries[key] = ("symlink", os.readlink(target).encode("utf-8", errors="surrogateescape"))
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                if metadata.st_size > MAX_TREE_FILE_BYTES or total_bytes + metadata.st_size > MAX_TREE_BYTES:
                    raise OSError("candidate tree exceeds verifier bounds")
                contents = target.read_bytes()
                total_bytes += len(contents)
                entries[key] = ("file", contents)
            elif stat.S_ISREG(metadata.st_mode):
                entries[key] = ("hardlink", b"")
            else:
                entries[key] = ("special", str(stat.S_IFMT(metadata.st_mode)).encode("ascii"))
        for name in names:
            target = directory_path / name
            if target.is_symlink():
                relative = target.relative_to(root).as_posix()
                entries[relative] = ("symlink", os.readlink(target).encode("utf-8", errors="surrogateescape"))
    return entries


def lock_candidate_tree(root: pathlib.Path) -> None:
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        directory_path = pathlib.Path(directory)
        for name in names:
            target = directory_path / name
            metadata = os.lstat(target)
            if stat.S_ISDIR(metadata.st_mode):
                os.chown(target, 0, 0, follow_symlinks=False)
                os.chmod(target, 0o555, follow_symlinks=False)
        for name in files:
            target = directory_path / name
            metadata = os.lstat(target)
            if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                os.chown(target, 0, 0, follow_symlinks=False)
                os.chmod(target, 0o444, follow_symlinks=False)
            elif not stat.S_ISLNK(metadata.st_mode):
                os.chown(target, 0, 0, follow_symlinks=False)
                os.chmod(target, 0o000, follow_symlinks=False)
    os.chown(root, 0, 0, follow_symlinks=False)
    os.chmod(root, 0o555, follow_symlinks=False)


def count_changed_lines(before: tuple[str, bytes] | None, after: tuple[str, bytes] | None) -> int:
    before_lines = decode_lines(before)
    after_lines = decode_lines(after)
    total = 0
    for operation, before_start, before_end, after_start, after_end in difflib.SequenceMatcher(None, before_lines, after_lines).get_opcodes():
        if operation != "equal":
            total += before_end - before_start + after_end - after_start
    return total


def decode_lines(entry: tuple[str, bytes] | None) -> list[str]:
    if entry is None or entry[0] != "file":
        return []
    return entry[1].decode("utf-8", errors="replace").splitlines()


def remove_stale_reward() -> None:
    if os.path.lexists(REWARD):
        if REWARD.is_dir() and not REWARD.is_symlink():
            raise OSError("reward path must not be a directory")
        REWARD.unlink()


def quarantine_untrusted_reward() -> None:
    if not os.path.lexists(REWARD):
        return
    quarantine = REWARD.with_name(f".untrusted-reward-{os.getpid()}")
    os.replace(REWARD, quarantine)


def write_reward(rewards: dict[str, int]) -> None:
    temporary = REWARD.with_name(f".reward-{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            json.dump(rewards, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, REWARD)
    except Exception:
        if os.path.lexists(temporary):
            temporary.unlink()
        raise


if __name__ == "__main__":
    main()
