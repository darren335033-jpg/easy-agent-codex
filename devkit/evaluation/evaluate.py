"""Execute candidate code only in disposable local Docker containers; see README.md."""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
from pathlib import Path
import secrets
import selectors
import subprocess
import sys
import time
import uuid

DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
SELECTORS = {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY")
SMOKE = Path(__file__).with_name("smoke.jsonl")
MAX_TASKS, MAX_TESTS, MAX_LINE, MAX_CODE = 64, 32, 262144, 131072
MAX_OUTPUT = 65536

WRAPPER = r'''
import json, sys, traceback
payload = json.loads(sys.stdin.read())
marker = payload["marker"]
compile_code, execute, catch = compile, exec, BaseException
namespace = {"__name__": "__main__"}
try:
    execute(compile_code(payload["code"], "<candidate>", "exec"), namespace)
    execute(compile_code(payload["test"], "<test>", "exec"), namespace)
except catch:
    traceback.print_exc(limit=8)
    print("\n" + marker + ":FAIL", flush=True)
    sys.exit(1)
print("\n" + marker + ":PASS", flush=True)
'''


@dataclasses.dataclass(frozen=True)
class Problem:
    task_id: str
    code: str
    tests: tuple[str, ...]


class CaptureError(Exception):
    def __init__(self, kind: str, output: bytes = b""):
        super().__init__(kind)
        self.kind, self.output = kind, output


def docker_env() -> dict[str, str]:
    """Keep registry configuration; prevent remote/context/TLS daemon selection."""
    return {key: value for key, value in os.environ.items() if key not in SELECTORS}


def capture(command: list[str], *, payload: bytes = b"", timeout: float = 5,
            limit: int = MAX_OUTPUT) -> tuple[int, bytes]:
    """Drain pipes concurrently with a strict memory/output bound and wall deadline."""
    process = subprocess.Popen(command, env=docker_env(), stdin=subprocess.PIPE if payload else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output, offset, deadline = bytearray(), 0, time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "read")
        if payload:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "write")
        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CaptureError("timeout", bytes(output))
            for key, _ in selector.select(min(remaining, 0.1)):
                if key.data == "read":
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        available = limit - len(output)
                        output.extend(chunk[:available])
                        if len(chunk) > available:
                            raise CaptureError("output_limit", bytes(output))
                else:
                    try:
                        offset += os.write(key.fd, payload[offset:offset + 4096])
                    except BrokenPipeError:
                        offset = len(payload)
                    if offset == len(payload):
                        selector.unregister(key.fileobj)
                        process.stdin.close()
        return process.wait(timeout=max(0.01, deadline - time.monotonic())), bytes(output)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        for stream in (process.stdin, process.stdout):
            if stream and not stream.closed:
                stream.close()


def load_problems(path: Path) -> list[Problem]:
    problems, identifiers = [], set()
    with path.open("rb") as source:
        while True:
            line = source.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                raise ValueError("JSONL line exceeds 256 KiB")
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except (ValueError, RecursionError) as error:
                raise ValueError("Invalid JSONL record") from error
            if not isinstance(record, dict) or set(record) - {"task_id", "prompt", "completion", "tests", "entry_point"}:
                raise ValueError("Each record must contain only the documented task fields")
            task_id, prompt, completion, tests = (record.get(key) for key in ("task_id", "prompt", "completion", "tests"))
            if not isinstance(task_id, str) or not task_id.strip() or len(task_id) > 128 or task_id in identifiers:
                raise ValueError("task_id must be unique, nonempty and at most 128 characters")
            if not isinstance(prompt, str) or not isinstance(completion, str):
                raise ValueError("prompt and completion must be strings")
            if len((prompt + completion).encode()) > MAX_CODE:
                raise ValueError("Candidate source exceeds 128 KiB")
            if not isinstance(tests, list) or not 1 <= len(tests) <= MAX_TESTS or any(not isinstance(t, str) or not t.strip() for t in tests):
                raise ValueError("tests must contain 1 to 32 nonempty Python snippets")
            entry_point = record.get("entry_point")
            if entry_point is not None:
                if not isinstance(entry_point, str) or not entry_point.isidentifier():
                    raise ValueError("entry_point must be a Python identifier")
                tests = [test + "\ncheck(" + entry_point + ")" for test in tests]
            identifiers.add(task_id)
            problems.append(Problem(task_id, prompt + completion, tuple(tests)))
            if len(problems) > MAX_TASKS:
                raise ValueError("At most 64 tasks may be evaluated per invocation")
    if not problems:
        raise ValueError("Dataset is empty")
    return problems


def runtime_available(runtime: str) -> None:
    query = "{{range $name, $runtime := .Runtimes}}{{$name}}{{println}}{{end}}"
    status, output = capture(DOCKER + ["info", "--format", query], limit=4096)
    if status != 0:
        raise RuntimeError("Local Docker daemon is unavailable")
    if runtime not in output.decode("utf-8").splitlines():
        raise RuntimeError(f"Required Docker runtime {runtime!r} is unavailable; no runtime downgrade performed")


def container_command(image: str, runtime: str, name: str) -> list[str]:
    command = DOCKER + ["run", "--rm", "--pull=never", "--name", name, "--runtime", runtime,
                        "--network", "none", "--read-only", "--user", "65534:65534", "--cap-drop", "ALL",
                        "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "256m",
                        "--memory-swap", "256m", "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
                        "--workdir", "/tmp", "--log-driver", "none", "--interactive"]
    for variable in PROXIES + tuple(variable.lower() for variable in PROXIES):
        command.extend(["--env", variable + "="])
    return command + ["--entrypoint", "python", "--", image, "-I", "-S", "-c", WRAPPER]


def cleanup_container(name: str) -> None:
    removed = subprocess.run(DOCKER + ["rm", "--force", name], env=docker_env(), stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, timeout=3, check=False)
    if removed.returncode == 0:
        return
    # --rm can remove an exited container before this controller's cleanup.
    status, output = capture(DOCKER + ["container", "inspect", "--format", "{{.Id}}", name], timeout=3, limit=4096)
    absence = {f"Error: No such container: {name}", f"Error: No such object: {name}"}
    if status != 0 and absence.intersection(output.decode("utf-8", errors="replace").splitlines()):
        return
    raise RuntimeError("Container removal could not be confirmed (local daemon failure or container still exists)")


def run_test(problem: Problem, test: str, *, image: str, runtime: str,
             timeout: float, startup_grace: float) -> dict:
    name, marker = "dazza-eval-" + uuid.uuid4().hex, "DAZZA_RESULT_" + secrets.token_hex(16)
    payload = json.dumps({"code": problem.code, "test": test, "marker": marker}).encode()
    result = None
    try:
        # Deadline covers startup + interpreter execution + output draining.
        status, output = capture(container_command(image, runtime, name), payload=payload, timeout=timeout + startup_grace)
        text = output.decode("utf-8", errors="replace")
        if status in (125, 126, 127):
            result = {"status": "infrastructure_error", "detail": text[-2000:]}
        else:
            passed = status == 0 and (marker + ":PASS\n") in text
            result = {"status": "passed" if passed else "failed", "detail": text.replace(marker, "[result]")[-2000:]}
    except CaptureError as error:
        result = {"status": "timeout" if error.kind == "timeout" else "failed", "detail": error.kind}
    except (OSError, subprocess.SubprocessError) as error:
        result = {"status": "infrastructure_error", "detail": str(error)}
    finally:
        try:
            cleanup_container(name)
        except (OSError, subprocess.SubprocessError, RuntimeError, CaptureError) as error:
            if result is not None:
                result.update(execution_status=result["status"], status="infrastructure_error",
                              cleanup_error=f"Could not confirm removal of {name}: {error}")
    return result


def evaluate(problems: list[Problem], *, image: str = "dazza-forge-eval:local", runtime: str = "runsc",
             timeout: float = 5, startup_grace: float = 2) -> dict:
    cases = []
    try:
        runtime_available(runtime)
    except (OSError, ValueError, RuntimeError, CaptureError, subprocess.SubprocessError) as error:
        cases = [{"task_id": p.task_id, "status": "infrastructure_error", "detail": str(error), "tests": []} for p in problems]
    else:
        for problem in problems:
            tests = [run_test(problem, test, image=image, runtime=runtime, timeout=timeout,
                              startup_grace=startup_grace) for test in problem.tests]
            statuses = {test["status"] for test in tests}
            status = next((s for s in ("infrastructure_error", "timeout", "failed") if s in statuses), "passed")
            cases.append({"task_id": problem.task_id, "status": status, "tests": tests})
    eligible = [case for case in cases if case["status"] != "infrastructure_error"]
    passed = sum(case["status"] == "passed" for case in eligible)
    incomplete = len(eligible) != len(cases)
    rate = passed / len(eligible) if eligible else None
    return {"schema_version": 1, "runtime": runtime, "image": image, "samples_per_task": 1,
            "total_tasks": len(cases), "evaluated_tasks": len(eligible), "passed_tasks": passed,
            "incomplete": incomplete, "pass_at_1": None if incomplete else rate,
            "evaluated_pass_rate": rate, "cases": cases}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", nargs="?", type=Path)
    parser.add_argument("--smoke", action="store_true", help="Use the checked-in, trusted smoke fixture")
    parser.add_argument("--image", default="dazza-forge-eval:local", help="Prebuilt local image; prefer a pinned digest")
    parser.add_argument("--timeout", type=float, default=5, help="Execution budget per test, seconds (0 < n <= 10)")
    parser.add_argument("--startup-grace", type=float, default=2, help="Additional startup budget, seconds (0 <= n <= 30)")
    parser.add_argument("--allow-standard-runtime", action="store_true", help="Weaker runc isolation; only valid with --smoke")
    args = parser.parse_args(argv)
    if bool(args.dataset) == args.smoke:
        parser.error("Choose exactly one dataset path or --smoke")
    if args.allow_standard_runtime and not args.smoke:
        parser.error("--allow-standard-runtime is restricted to the trusted --smoke fixture")
    if not 0 < args.timeout <= 10 or not 0 <= args.startup_grace <= 30:
        parser.error("Invalid timeout or startup grace")
    try:
        problems = load_problems(SMOKE if args.smoke else args.dataset)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    report = evaluate(problems, image=args.image, runtime="runc" if args.allow_standard_runtime else "runsc",
                      timeout=args.timeout, startup_grace=args.startup_grace)
    print(json.dumps(report, indent=2))
    return 2 if report["incomplete"] else (0 if report["passed_tasks"] == report["total_tasks"] else 1)


if __name__ == "__main__":
    sys.exit(main())
