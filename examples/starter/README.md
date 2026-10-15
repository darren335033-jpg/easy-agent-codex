# Easy Agent AI demo repository

This small Python project contains an intentional addition bug. Its tests use Python's standard library and need no package installation.

In the local workspace, select an available model and submit:

> Fix the calculator's add function without weakening the tests. Inspect the files, run python:unittest in the sandbox, propose the smallest fix, and run the tests again.

Inspect the recorded tool calls and test results, review the proposed diff, and apply the selected change. Run the Python test profile against the repository, then create a branch and commit the reviewed files.

The test runner requires local Docker with the gVisor `runsc` runtime and the Python runner image. Without that infrastructure, testing reports an infrastructure error. Model responses are supplied by your configured Ollama or Vertex AI provider.

`npm run demo` keeps this repository at `.forge/demo` between launches. It does not reset your edits or Git history. To begin another example, make a separate copy of the original `examples/starter` files.
