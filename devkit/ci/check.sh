#!/usr/bin/env bash
set -euo pipefail
forge_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$forge_repo_root"
npm test
python3 -m unittest discover -s devkit/tests -p 'test_*.py'
# Candidate execution belongs on a dedicated worker with the default runsc runtime.
if [[ -n "${FORGE_EVALUATION_CASES:-}" ]]; then
  python3 -m devkit.evaluation.evaluate "$FORGE_EVALUATION_CASES" \
    --image "${FORGE_EVALUATION_IMAGE:-dazza-forge-eval:local}"
fi
