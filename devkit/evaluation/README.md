# Local coding evaluation

This stdlib CLI evaluates one completion per problem. Candidate Python runs only
inside a fresh container for each test. Host Python parses JSON and controls the
local Docker daemon; it never imports, compiles, or executes candidate code.
No model API, cloud service, training job, or paid inference is used.

The default runtime is gVisor (`runsc`). Missing Docker, image, or runtime fails
closed and reports an infrastructure error; the CLI never downloads an image or
falls back to another runtime. Docker must expose its local Unix socket and
`runsc` must already be configured by the host administrator. Access to Docker's
socket grants substantial host privileges: run this controller only in a
dedicated evaluation worker, not an untrusted multi-tenant service.

From the repository root, build the trusted image (the build may download the
base image), then run the checked-in fixture:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock build \
  -t dazza-forge-eval:local devkit/evaluation
python -m devkit.evaluation.evaluate --smoke
python -m devkit.evaluation.evaluate /path/to/candidates.jsonl --image image@sha256:VERIFIED_DIGEST
python -m unittest devkit.tests.test_evaluation
```

For reproducibility, pass `--build-arg BASE_IMAGE=image@sha256:VERIFIED_DIGEST`
when building and use your built image's verified repository digest at runtime.
The default local tag is intentionally not described as immutable.
Preserve Docker registry credentials/configuration; the controller strips
remote-daemon/context/TLS selectors and explicitly selects
`unix:///var/run/docker.sock` on every Docker command.

For a trusted installation smoke check only, `--smoke --allow-standard-runtime`
explicitly selects `runc`. This is weaker process isolation and is unsuitable
for adversarial generated code. Arbitrary dataset paths cannot use this flag.
Neither gVisor nor these resource limits are an absolute isolation guarantee;
keep the dedicated worker, Docker, kernel and runtime patched. This harness
does not provision Firecracker, a remote sandbox, or a public execution service.

Each JSONL line has this shape:

```json
{"task_id":"example/add","prompt":"def add(a,b):\n","completion":"    return a+b\n","tests":["assert add(2,3)==5"]}
```

`prompt + completion` is the complete Python source, without markdown fences.
`tests` contains trusted Python snippets. An optional `entry_point` identifier
causes `check(entry_point)` to be appended to each test snippet; this supports
HumanEval-style `def check(candidate): ...` fixtures. Convert MBPP's setup code
and assertions into explicit test snippets as needed. Official benchmark data
is not bundled. IDs must be unique. Each run accepts at most 64 tasks, 32 tests
per task, 256 KiB per JSONL line and 128 KiB of candidate source.

Every test starts with a clean container and interpreter. The container has no
network, host mounts, Docker socket, or forwarded host environment/credentials.
Proxy variables that Docker client configuration might inject are explicitly
emptied. The trusted image must itself contain no secrets. Runtime limits are
256 MiB RAM including swap allowance, one CPU, 64 processes, a read-only root,
UID/GID 65534, no capabilities, no new privileges, Docker's default seccomp
profile, and a 16 MiB `/tmp` tmpfs with `nosuid,nodev,noexec`. Python can still
interpret files on a `noexec` filesystem; isolation comes from the runtime.
Container logs are disabled and stdout/stderr is capped at 64 KiB per test.

`--timeout` defaults to 5 seconds (maximum 10). `--startup-grace` adds a bounded
container startup allowance, default 2 seconds (maximum 30); the combined wall
deadline covers startup, source execution, tests, and output draining. It is
not an exact CPU-time measurement. A named container is forcibly removed after
each invocation, including timeouts and output overflow. A nonzero `docker rm`
status triggers a bounded inspect request; only confirmed absence is accepted.
Cleanup uncertainty marks the result incomplete and identifies the container
for administrator inspection, including daemon outages and command timeouts.

Results contain `passed`, `failed`, `timeout`, or `infrastructure_error` per
task and test. Timeouts and output overflow are candidate failures. Missing
runtime/image/daemon and Docker invocation errors are infrastructure errors.
`pass_at_1` is the fraction of all tasks passing their single supplied sample;
it is null when infrastructure errors make a run incomplete. A separate
`evaluated_pass_rate` reports the evaluated subset. No official HumanEval/MBPP
score or statistical pass@k estimate is claimed. Model selection, contamination,
dataset provenance, test coverage, and sampling must be controlled separately.

The completion marker detects accidental early exits; Python tests execute in
the same interpreter as the completion. An adversarial completion can inspect
or tamper with that oracle. This is a correctness harness for cooperative model
evaluation, not a tamper-resistant grading protocol. Do not treat passing
results as proof of security or code quality.

Exit statuses: `0` all passed, `1` candidate failure/timeout, `2` invalid input or
incomplete infrastructure run. JSON reports go to stdout.
