#!/usr/bin/env bash
# ProjectMind Universal Installer for Linux & macOS
# https://github.com/Rootx202/ProjectMind
set -euo pipefail

VERSION="1.1.0"
REPO="Rootx202/ProjectMind"
USER_HOME="${HOME:-${USERPROFILE:-/tmp}}"
DEFAULT_INSTALL_DIR="${PROJECTMIND_HOME:-${USER_HOME}/.projectmind}"
BIN_DIR="${USER_HOME}/.local/bin"

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
  --bin-dir <dir>      Binary wrapper directory (default: ~/.local/bin)
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

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required to install ProjectMind runtime." >&2
  exit 1
fi

# 2. Determine execution context (local clone vs remote pipe/curl install)
IS_LOCAL_REPO=false
REPO_ROOT=""

# Safely check BASH_SOURCE without triggering unbound variable under set -u
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -n "${SCRIPT_SOURCE}" ]] && [[ -f "${SCRIPT_SOURCE}" ]]; then
  DETECTED_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
  if [[ -f "${DETECTED_DIR}/package.json" ]] && grep -q '"name": "projectmind"' "${DETECTED_DIR}/package.json" 2>/dev/null; then
    IS_LOCAL_REPO=true
    REPO_ROOT="${DETECTED_DIR}"
  fi
fi

# Fallback: check current directory if script was piped into bash (curl | bash) inside an existing clone
if [[ "${IS_LOCAL_REPO}" = false ]] && [[ -f "$(pwd)/package.json" ]] && grep -q '"name": "projectmind"' "$(pwd)/package.json" 2>/dev/null; then
  IS_LOCAL_REPO=true
  REPO_ROOT="$(pwd)"
fi

# 3. Setup directories
if [[ "${DRY_RUN}" = true ]]; then
  echo "[Dry-Run] Target install prefix: ${PREFIX}"
  echo "[Dry-Run] Target bin directory:  ${BIN_DIR}"
else
  mkdir -p "${PREFIX}" "${BIN_DIR}"
fi

# 4. Build or Install ProjectMind Runtime
if [[ "${IS_LOCAL_REPO}" = true ]]; then
  echo "✓ Detected local repository checkout at: ${REPO_ROOT}"
  CLI_SCRIPT="${REPO_ROOT}/apps/cli/dist/index.js"
  
  if [[ "${DRY_RUN}" = false ]]; then
    # Ensure npm workspace packages are linked
    SCOPE_DIR="${REPO_ROOT}/node_modules/@projectmind"
    if [[ ! -d "${SCOPE_DIR}" ]] || [[ ! -e "${SCOPE_DIR}/shared" ]]; then
      echo "Linking npm workspaces..."
      (
        cd "${REPO_ROOT}"
        npm install --prefer-offline 2>/dev/null || npm install
      )
    fi
    
    # Always ensure packages are built
    echo "Building ProjectMind packages..."
    node "${REPO_ROOT}/scripts/build.js"
  else
    echo "[Dry-Run] Would link workspaces and build packages in ${REPO_ROOT}"
  fi
else
  echo "Installing ProjectMind standalone runtime to ${PREFIX}..."
  CLI_SCRIPT="${PREFIX}/apps/cli/dist/index.js"
  
  if [[ "${DRY_RUN}" = false ]]; then
    ARCHIVE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/projectmind-full.tar.gz"
    ARCHIVE_FILE="${PREFIX}/projectmind-full.tar.gz"
    DOWNLOADED=false
    
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSL "${ARCHIVE_URL}" -o "${ARCHIVE_FILE}" 2>/dev/null; then
        DOWNLOADED=true
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q "${ARCHIVE_URL}" -O "${ARCHIVE_FILE}" 2>/dev/null; then
        DOWNLOADED=true
      fi
    fi
    
    if [[ "${DOWNLOADED}" = true ]] && [[ -s "${ARCHIVE_FILE}" ]]; then
      echo "Extracting release archive..."
      tar -xzf "${ARCHIVE_FILE}" -C "${PREFIX}"
      rm -f "${ARCHIVE_FILE}"
    else
      echo "Release archive not reachable. Cloning repository..."
      if command -v git >/dev/null 2>&1; then
        rm -rf "${PREFIX}"
        mkdir -p "${PREFIX}"
        git clone --depth 1 "https://github.com/${REPO}.git" "${PREFIX}"
      else
        echo "Error: Failed to download release archive and git is not installed." >&2
        exit 1
      fi
    fi
    
    echo "Configuring runtime dependencies..."
    (
      cd "${PREFIX}"
      npm install --omit=dev --prefer-offline 2>/dev/null || npm install --omit=dev
      node scripts/build.js
    )
  else
    echo "[Dry-Run] Would download release archive, extract to ${PREFIX}, and build runtime."
  fi
fi

# 5. Create executable wrapper in BIN_DIR
CLI_BIN="${BIN_DIR}/projectmind"
if [[ "${DRY_RUN}" = true ]]; then
  echo "[Dry-Run] Would create executable wrapper ${CLI_BIN} -> ${CLI_SCRIPT}"
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
  sed -i "s|__TARGET_CLI_PATH__|${CLI_SCRIPT}|g" "${CLI_BIN}"
  chmod +x "${CLI_BIN}"
  echo "✓ Installed executable: ${CLI_BIN}"
fi

# 6. Check PATH
case ":${PATH}:" in
  *:"${BIN_DIR}":*) ;;
  *)
    echo ""
    echo "Notice: ${BIN_DIR} is not in your current PATH."
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
  if ! node "${CLI_SCRIPT}" plugin doctor; then
    echo "" >&2
    echo "Error: ProjectMind diagnostics failed. Installation is incomplete or broken." >&2
    exit 1
  fi
fi

echo ""
echo "=========================================================="
echo "ProjectMind installation completed successfully!"
echo "Run 'projectmind --help' to get started."
echo "=========================================================="
