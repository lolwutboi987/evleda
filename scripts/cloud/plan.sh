#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
python="$repo_root/.venv/bin/python"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/cloud/plan.sh" >&2
  exit 2
fi
if [ ! -x "$python" ]; then
  echo "Cloud virtual environment is missing; run scripts/cloud/setup.sh" >&2
  exit 2
fi

exec "$python" "$script_dir/reference_workflow.py" plan
