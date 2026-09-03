#!/usr/bin/env sh
set -eu

# Codex cloud runs setup in a separate Bash session.  Everything needed later
# therefore lives in the repository-scoped virtual environment; no export is
# expected to persist into the agent phase.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
venv="$repo_root/.venv"
required_kicad="10.0.6"
kicad_cli="/usr/bin/kicad-cli"
install_kicad=${EVLEDA_CLOUD_INSTALL_KICAD:-1}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

case "$install_kicad" in
  0|1) ;;
  *)
    echo "EVLEDA_CLOUD_INSTALL_KICAD must be 0 or 1" >&2
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "EvlEDA's cloud setup supports Linux only" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required" >&2
  exit 2
fi

python3 -c 'import sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] < (3, 15) else 2)' || {
  echo "EvlEDA requires Python 3.12, 3.13, or 3.14" >&2
  exit 2
}

if [ ! -x "$kicad_cli" ] && [ "$install_kicad" = "1" ]; then
  if [ ! -r /etc/os-release ]; then
    echo "Automatic KiCad installation requires Ubuntu" >&2
    exit 2
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    echo "Automatic KiCad installation is supported only on Ubuntu" >&2
    exit 2
  fi
  if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
      echo "Root or passwordless sudo is required to install KiCad in Codex cloud" >&2
      exit 2
    fi
  fi
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install --yes \
    ca-certificates software-properties-common
  as_root add-apt-repository --yes ppa:kicad/kicad-10.0-releases
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
  candidate=$(apt-cache policy kicad | awk '/Candidate:/ { print $2; exit }')
  case "$candidate" in
    "$required_kicad"|"$required_kicad"[-+~.:]*) ;;
    *)
      echo "The official KiCad 10 PPA does not offer the required $required_kicad build" >&2
      exit 2
      ;;
  esac
  case "$candidate" in
    *[!A-Za-z0-9.+:~_-]*)
      echo "The selected KiCad package version has unsafe syntax" >&2
      exit 2
      ;;
  esac
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install --yes \
    --install-recommends "kicad=$candidate"
fi

if [ ! -x "$kicad_cli" ] || [ -L "$kicad_cli" ]; then
  echo "$kicad_cli must be a regular, non-symlink executable; install KiCad $required_kicad or rerun setup with installation enabled" >&2
  exit 2
fi
if [ "$("$kicad_cli" version)" != "$required_kicad" ]; then
  echo "The fixed reference profile requires $kicad_cli $required_kicad exactly" >&2
  exit 2
fi

if [ -L "$venv" ]; then
  echo "Refusing a symlinked cloud virtual environment" >&2
  exit 2
fi
python3 -m venv "$venv"
"$venv/bin/python" -m pip install --disable-pip-version-check --no-input --editable "$repo_root"
"$venv/bin/python" -m pip check
"$venv/bin/evleda-mcp" --version
"$venv/bin/evleda-mcp" smoke
"$venv/bin/python" "$script_dir/reference_workflow.py" smoke

echo "EvlEDA cloud setup passed with kicad-cli $required_kicad"
