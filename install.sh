#!/usr/bin/env bash
# ProjectMind Universal Installer for Linux & macOS
# https://github.com/Rootx202/ProjectMind
set -euo pipefail

VERSION="1.1.0"
REPO="Rootx202/ProjectMind"
DEFAULT_INSTALL_DIR="${HOME}/.projectmind"
BIN_DIR="${HOME}/.local/bin"

TARGET_AGENT=""
INSTALL_ALL=false
DRY_RUN=false
NO_VERIFY=false
PREFIX="${DEFAULT_INSTALL_DIR}"

show_help() {
  cat <<EOF
ProjectMind Installer v${VERSION} (Linux/macOS)

Usage:
  ./install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- [options]

Options:
  --agent <name>       Install integration for a specific agent:
                       (antigravity, claude-code, codex, cursor, gemini-cli,
                        github-copilot, deepseek-harness, hermes-agent, opencode)
  --all                Install integrations for all 9 supported agents
  --prefix <dir>       Installation directory (default: ~/.projectmind)
  --bin-dir <dir>      Binary symlink directory (default: ~/.local/bin)
  --dry-run            Simulate installation steps without modifying files
  --no-verify          Skip post-install diagnostic verification
  -h, --help           Show this help message

Environment Variables:
  PROJECTMIND_HOME     Override installation root directory
  PROJECTMIND_PROJECT_ROOT Override target project directory
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      TARGET_AGENT="$2"
      shift 2
      ;;
    --all)
      INSTALL_ALL=true
      shift
      ;;
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-verify)
      NO_VERIFY=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

echo "=========================================================="
echo "ProjectMind Installer v${VERSION}"
echo "=========================================================="

# 1. Check Node.js runtime
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but was not found in PATH." >&2
  echo "Please install Node.js v18.0.0 or higher: https://nodejs.org/" >&2
  exit 1
fi

NODE_VER=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "${NODE_VER}" | cut -d. -f1)

if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Error: Node.js v18.0.0 or higher is required. Found v${NODE_VER}." >&2
  exit 1
fi
echo "✓ Node.js v${NODE_VER} detected (>= 18.0.0)"

# 2. Determine execution context (local clone vs remote install)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IS_LOCAL_REPO=false

if [[ -f "${SCRIPT_DIR}/package.json" ]] && grep -q '"name": "projectmind"' "${SCRIPT_DIR}/package.json" 2>/dev/null; then
  IS_LOCAL_REPO=true
  REPO_ROOT="${SCRIPT_DIR}"
  echo "✓ Detected local repository at: ${REPO_ROOT}"
fi

# 3. Setup directories
if [[ "${DRY_RUN}" = true ]]; then
  echo "[Dry-Run] Would create directory: ${PREFIX}"
  echo "[Dry-Run] Would create directory: ${BIN_DIR}"
else
  mkdir -p "${PREFIX}" "${BIN_DIR}"
fi

# 4. Build or Link ProjectMind Runtime
if [[ "${IS_LOCAL_REPO}" = true ]]; then
  CLI_SCRIPT="${REPO_ROOT}/apps/cli/dist/index.js"
  if [[ ! -f "${CLI_SCRIPT}" ]]; then
    echo "Building ProjectMind packages..."
    if [[ "${DRY_RUN}" = false ]]; then
      node "${REPO_ROOT}/scripts/build.js"
    fi
  fi
else
  echo "Setting up ProjectMind runtime in ${PREFIX}..."
  # If distributed via npm or archive, unpack to prefix
  CLI_SCRIPT="${PREFIX}/apps/cli/dist/index.js"
fi

# 5. Create / Update symlink in bin directory
CLI_BIN="${BIN_DIR}/projectmind"
if [[ "${DRY_RUN}" = true ]]; then
  echo "[Dry-Run] Would link ${CLI_SCRIPT} -> ${CLI_BIN}"
else
  mkdir -p "${BIN_DIR}"
  cat << 'RUNNER_EOF' > "${CLI_BIN}"
#!/usr/bin/env bash
TARGET_JS="__TARGET_CLI_PATH__"
if command -v node >/dev/null 2>&1; then
  exec node "${TARGET_JS}" "$@"
else
  echo "Error: Node.js is required to run ProjectMind." >&2
  exit 1
fi
RUNNER_EOF
  # Replace placeholder with absolute CLI path
  sed -i "s|__TARGET_CLI_PATH__|${CLI_SCRIPT}|g" "${CLI_BIN}"
  chmod +x "${CLI_BIN}"
  echo "✓ Installed executable: ${CLI_BIN}"
fi

# 6. Check PATH
case ":${PATH}:" in
  *:"${BIN_DIR}":*) ;;
  *)
    echo ""
    echo "Notice: ${BIN_DIR} is not in your PATH."
    echo "Add it to your shell configuration file (~/.bashrc or ~/.zshrc):"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    echo ""
    ;;
esac

# 7. Agent Plugin Installation (if requested)
if [[ -n "${TARGET_AGENT}" ]] || [[ "${INSTALL_ALL}" = true ]]; then
  CWD="$(pwd)"
  if [[ "${INSTALL_ALL}" = true ]]; then
    echo "Installing all 9 agent plugins into ${CWD}..."
    if [[ "${DRY_RUN}" = false ]]; then
      node "${CLI_SCRIPT}" plugin install --all --yes --project-root "${CWD}"
    else
      echo "[Dry-Run] Would execute: projectmind plugin install --all"
    fi
  elif [[ -n "${TARGET_AGENT}" ]]; then
    echo "Installing plugin '${TARGET_AGENT}' into ${CWD}..."
    if [[ "${DRY_RUN}" = false ]]; then
      node "${CLI_SCRIPT}" plugin install "${TARGET_AGENT}" --yes --project-root "${CWD}"
    else
      echo "[Dry-Run] Would execute: projectmind plugin install ${TARGET_AGENT}"
    fi
  fi
fi

# 8. Post-installation Verification
if [[ "${NO_VERIFY}" = false ]] && [[ "${DRY_RUN}" = false ]]; then
  echo ""
  echo "Running ProjectMind system diagnostics..."
  node "${CLI_SCRIPT}" plugin doctor || true
fi

echo ""
echo "=========================================================="
echo "ProjectMind installation completed successfully!"
echo "Run 'projectmind --help' to get started."
echo "=========================================================="

