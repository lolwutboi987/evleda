#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
python="$repo_root/.venv/bin/python"

if [ ! -x "$python" ]; then
  echo "Cloud virtual environment is missing; rerun scripts/cloud/setup.sh" >&2
  exit 2
fi

# The agent phase may have no network.  Refresh only this checkout's editable
# install and use dependencies already installed during setup.
"$python" -m pip install --disable-pip-version-check --no-input --no-deps \
  --editable "$repo_root"
"$repo_root/.venv/bin/evleda-mcp" smoke
"$python" "$script_dir/reference_workflow.py" smoke
