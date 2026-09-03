#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
python="$repo_root/.venv/bin/python"

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/cloud/run.sh APPROVED_SHA256 NEW_OUTPUT_DIRECTORY" >&2
  exit 2
fi
approval=$1
output=$2

case "$approval" in
  *[!0-9a-f]*)
    echo "APPROVED_SHA256 must contain exactly 64 lowercase hexadecimal characters" >&2
    exit 2
    ;;
esac
if [ "${#approval}" -ne 64 ]; then
  echo "APPROVED_SHA256 must contain exactly 64 lowercase hexadecimal characters" >&2
  exit 2
fi
if [ ! -x "$python" ]; then
  echo "Cloud virtual environment is missing; run scripts/cloud/setup.sh" >&2
  exit 2
fi

exec "$python" "$script_dir/reference_workflow.py" run \
  --approve-digest "$approval" --output-dir "$output" \
  --kicad-cli /usr/bin/kicad-cli
