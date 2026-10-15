"""Controller tests use mocks and pipes, never execute a completion on the host."""

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from devkit.evaluation import evaluate as ev


class EvaluationTests(unittest.TestCase):
    def load(self, records):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.jsonl"
            path.write_text("\n".join(json.dumps(record) for record in records))
            return ev.load_problems(path)

    def record(self, **overrides):
        return dict(task_id="add/1", prompt="def add(a,b):\n", completion="    return a+b\n",
                    tests=["assert add(2,3)==5"], **overrides)

    def test_source_is_data_until_container(self):
        record = self.record()
        record["completion"] = "    raise Exception('never execute on host')"
        problems = self.load([record])
        self.assertIn("never execute on host", problems[0].code)

    def test_humaneval_check_adapter(self):
        record = self.record(entry_point="add")
        record["tests"] = ["def check(candidate):\n    assert candidate(2,3)==5"]
        self.assertTrue(self.load([record])[0].tests[0].endswith("\ncheck(add)"))

    def test_duplicate_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            self.load([self.record(), self.record()])

    def test_invalid_input_formats(self):
        for replacement in ({"tests": []}, {"tests": [1]}, {"completion": None},
                            {"entry_point": "add()"}, {"task_id": ""}, {"unknown": True}):
            record = self.record()
            record.update(replacement)
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                self.load([record])

    def test_input_size_limits(self):
        record = self.record()
        record["completion"] = "x" * (ev.MAX_CODE + 1)
        with self.assertRaisesRegex(ValueError, "128 KiB"):
            self.load([record])
        record["completion"] = "x" * (ev.MAX_LINE + 1)
        with self.assertRaisesRegex(ValueError, "256 KiB"):
            self.load([record])
        with self.assertRaisesRegex(ValueError, "empty"):
            self.load([])

    def test_deeply_nested_json_is_rejected_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deep.jsonl"
            path.write_text("[" * 2000 + "]" * 2000)
            with self.assertRaises(ValueError):
                ev.load_problems(path)

    def test_task_and_test_limits(self):
        records = [dict(self.record(), task_id=str(number)) for number in range(ev.MAX_TASKS + 1)]
        with self.assertRaisesRegex(ValueError, "64 tasks"):
            self.load(records)
        record = self.record()
        record["tests"] *= ev.MAX_TESTS + 1
        with self.assertRaisesRegex(ValueError, "1 to 32"):
            self.load([record])

    def test_docker_env_keeps_registry_config_and_strips_selectors(self):
        environ = {key: "remote-value" for key in ev.SELECTORS}
        environ.update(DOCKER_CONFIG="/trusted/config", HTTP_PROXY="http://proxy")
        with patch.dict(os.environ, environ, clear=True):
            clean = ev.docker_env()
        self.assertFalse(ev.SELECTORS.intersection(clean))
        self.assertEqual(clean["DOCKER_CONFIG"], "/trusted/config")

    def test_container_has_all_required_isolation_flags(self):
        command = ev.container_command("trusted@sha256:abc", "runsc", "dazza-eval-test")
        joined = " ".join(command)
        for required in ("--host=unix:///var/run/docker.sock", "--pull=never", "--runtime runsc",
                         "--network none", "--read-only", "--user 65534:65534", "--cap-drop ALL",
                         "--security-opt no-new-privileges:true", "--pids-limit 64", "--memory 256m",
                         "--memory-swap 256m", "--cpus 1", "/tmp:rw,nosuid,nodev,noexec,size=16m",
                         "--log-driver none", "--entrypoint python", "-I -S -c"):
            self.assertIn(required, joined)
        for proxy in ev.PROXIES + tuple(value.lower() for value in ev.PROXIES):
            self.assertIn(proxy + "=", command)
        self.assertNotIn("--volume", command)
        self.assertNotIn("--mount", command)
        self.assertNotIn("--privileged", command)
        self.assertEqual(command[command.index("--"):command.index("--") + 2], ["--", "trusted@sha256:abc"])

    @patch.object(ev, "capture", return_value=(0, b"runc\n"))
    def test_missing_runsc_never_downgrades(self, capture):
        report = ev.evaluate(self.load([self.record()]))
        self.assertTrue(report["incomplete"])
        self.assertIsNone(report["pass_at_1"])
        self.assertEqual(report["cases"][0]["status"], "infrastructure_error")
        capture.assert_called_once()

    @patch.object(ev.subprocess, "run", return_value=Mock(returncode=0))
    def test_completion_sent_only_via_stdin_and_marker_required(self, cleanup):
        problem = self.load([self.record()])[0]

        def success(command, **options):
            payload = json.loads(options["payload"])
            self.assertEqual(payload["code"], problem.code)
            self.assertNotIn(problem.code, command)
            self.assertEqual(options["timeout"], 7)
            return 0, (payload["marker"] + ":PASS\n").encode()

        with patch.object(ev, "capture", side_effect=success):
            result = ev.run_test(problem, problem.tests[0], image="test", runtime="runsc", timeout=5, startup_grace=2)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(cleanup.call_args.args[0][:4], ev.DOCKER + ["rm", "--force"])
        with patch.object(ev, "capture", return_value=(0, b"fake success, no marker")):
            result = ev.run_test(problem, problem.tests[0], image="test", runtime="runsc", timeout=5, startup_grace=2)
        self.assertEqual(result["status"], "failed")

    @patch.object(ev.subprocess, "run", return_value=Mock(returncode=0))
    def test_timeouts_output_limits_and_docker_errors_cleanup(self, cleanup):
        problem = self.load([self.record()])[0]
        for error, expected in ((ev.CaptureError("timeout"), "timeout"),
                                (ev.CaptureError("output_limit"), "failed"),
                                (FileNotFoundError("docker missing"), "infrastructure_error")):
            with self.subTest(error=error), patch.object(ev, "capture", side_effect=error):
                result = ev.run_test(problem, problem.tests[0], image="test", runtime="runsc", timeout=5, startup_grace=2)
                self.assertEqual(result["status"], expected)
        self.assertEqual(cleanup.call_count, 3)

    @patch.object(ev.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker rm", 3))
    @patch.object(ev, "capture", side_effect=ev.CaptureError("timeout"))
    def test_cleanup_timeout_reports_incomplete_infrastructure(self, capture, cleanup):
        problem = self.load([self.record()])[0]
        result = ev.run_test(problem, problem.tests[0], image="test", runtime="runsc", timeout=5, startup_grace=2)
        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(result["execution_status"], "timeout")
        self.assertIn("dazza-eval-", result["cleanup_error"])

    @patch.object(ev.subprocess, "run", return_value=Mock(returncode=1))
    def test_nonzero_cleanup_requires_confirmed_absence(self, remove):
        name = "dazza-eval-owned"
        with patch.object(ev, "capture", return_value=(1, f"Error: No such container: {name}\n".encode())):
            ev.cleanup_container(name)
        for status, output in ((1, b"Cannot connect to the Docker daemon"), (0, b"container-still-exists")):
            with self.subTest(status=status), patch.object(ev, "capture", return_value=(status, output)):
                with self.assertRaisesRegex(RuntimeError, "could not be confirmed"):
                    ev.cleanup_container(name)

    @patch.object(ev.subprocess, "run", return_value=Mock(returncode=1))
    def test_nonzero_cleanup_daemon_failure_marks_infrastructure(self, remove):
        problem = self.load([self.record()])[0]
        with patch.object(ev, "capture", side_effect=[(0, b"candidate exited early"), (1, b"daemon failed")]):
            result = ev.run_test(problem, problem.tests[0], image="test", runtime="runsc", timeout=5, startup_grace=2)
        self.assertEqual(result["status"], "infrastructure_error")
        self.assertEqual(result["execution_status"], "failed")
        self.assertIn("cleanup_error", result)

    @patch.object(ev, "runtime_available")
    @patch.object(ev, "run_test")
    def test_metric_marks_incomplete_infrastructure(self, run_test, runtime):
        problems = self.load([self.record(), dict(self.record(), task_id="add/2")])
        run_test.side_effect = [{"status": "passed"}, {"status": "infrastructure_error"}]
        report = ev.evaluate(problems)
        self.assertIsNone(report["pass_at_1"])
        self.assertTrue(report["incomplete"])
        self.assertEqual(report["evaluated_pass_rate"], 1)
        run_test.side_effect = [{"status": "passed"}, {"status": "timeout"}]
        self.assertEqual(ev.evaluate(problems)["pass_at_1"], 0.5)

    def test_standard_runtime_is_smoke_only(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            ev.main(["arbitrary.jsonl", "--allow-standard-runtime"])
        self.assertEqual(error.exception.code, 2)


class BoundedCaptureTests(unittest.TestCase):
    """Mock Popen with pipe data; no subprocess or candidate Python is started."""

    def process(self, content):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, content)
        os.close(write_fd)
        process = Mock()
        process.stdout = os.fdopen(read_fd, "rb")
        process.stdin = None
        process.poll.return_value = 0
        process.wait.return_value = 0
        return process

    def test_output_is_bounded(self):
        process = self.process(b"x" * 100)
        with patch.object(ev.subprocess, "Popen", return_value=process), self.assertRaises(ev.CaptureError) as error:
            ev.capture(ev.DOCKER, limit=16)
        self.assertEqual(error.exception.kind, "output_limit")
        self.assertEqual(len(error.exception.output), 16)

    def test_small_output_is_returned(self):
        process = self.process(b"trusted mock output")
        with patch.object(ev.subprocess, "Popen", return_value=process):
            status, output = ev.capture(ev.DOCKER)
        self.assertEqual((status, output), (0, b"trusted mock output"))

    def test_wall_deadline_kills_controller_process(self):
        process = self.process(b"")
        process.poll.side_effect = [None, None]
        with patch.object(ev.subprocess, "Popen", return_value=process), patch.object(ev.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaises(ev.CaptureError) as error:
                ev.capture(ev.DOCKER, timeout=1)
        self.assertEqual(error.exception.kind, "timeout")
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)


if __name__ == "__main__":
    unittest.main()
