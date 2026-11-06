# ProjectMind on Linux

This guide covers deployment, configuration, system integration, and troubleshooting for ProjectMind across GNU/Linux distributions.

---

## 1. Supported Distributions

ProjectMind is fully tested on:
* **Debian / Ubuntu / Kali Linux** (`apt`)
* **Fedora / RHEL / CentOS Stream / Rocky Linux** (`dnf` / `rpm`)
* **Arch Linux / Manjaro** (`pacman`)
* **Alpine Linux** (`apk` — requires standard Node.js libc)
* **openSUSE Tumbleweed & Leap** (`zypper`)

---

## 2. Linux Prerequisites

* **Node.js**: `v18.0.0` or higher.
  * Ubuntu / Debian:
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
  * Fedora / RHEL:
    ```bash
    sudo dnf install -y nodejs
    ```
  * Arch Linux:
    ```bash
    sudo pacman -S nodejs npm
    ```

---

## 3. Standard Installation

```bash
# Clone and run the POSIX installer
git clone https://github.com/projectmind/projectmind.git
cd projectmind
./install.sh

# Or install for a specific agent directly
./install.sh --agent antigravity
```

The installer creates a runner script at `~/.local/bin/projectmind`. Ensure `~/.local/bin` is in your `$PATH`:

```bash
# Add to ~/.bashrc or ~/.zshrc if not present
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## 4. XDG Directory Specification Compliance

ProjectMind strictly adheres to the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):

| Path Type | Default Linux Location | Environment Variable Override |
| :--- | :--- | :--- |
| **User Configuration** | `~/.config/projectmind` | `$XDG_CONFIG_HOME/projectmind` |
| **Global Data & State** | `~/.local/share/projectmind` | `$XDG_DATA_HOME/projectmind` |
| **Cache & Transients** | `~/.cache/projectmind` | `$XDG_CACHE_HOME/projectmind` |
| **Project Workspace State** | `<project-root>/.projectmind` | Managed locally within repository |

---

## 5. File Descriptor Limits (`ulimit`)

On large enterprise repositories (50,000+ files), bootstrap indexing scans many file descriptors in batches. If you encounter `EMFILE: too many open files`:

Check your current limit:
```bash
ulimit -n
```

If it is `1024`, increase it temporarily or persistently:

```bash
# Temporary increase for current shell session:
ulimit -n 65536

# Persistent increase in /etc/security/limits.conf:
# * soft nofile 65536
# * hard nofile 65536
```

---

## 6. Headless, SSH, and Container Environments

ProjectMind has zero graphical dependencies and is built for headless terminal use, remote servers over SSH, and Docker containers:

### Docker Container Setup
```dockerfile
FROM node:20-slim

WORKDIR /app
RUN npm install -g projectmind

# ProjectMind runs 100% offline
ENV PROJECTMIND_HOME=/app/.projectmind
CMD ["projectmind", "plugin", "doctor"]
```

### Remote SSH Development
When using VS Code Remote-SSH, Cursor Remote-SSH, or terminal agents (Claude Code, Gemini CLI, Hermes Agent, OpenCode, DeepSeek Harness), ProjectMind runs directly on the remote Linux host.

---

## 7. Optional Systemd User Service

To maintain automatic file synchronization as a background daemon across login sessions:

1. Create `~/.config/systemd/user/projectmind-sync@.service`:
```ini
[Unit]
Description=ProjectMind Auto-Sync Daemon for %I
After=network.target

[Service]
Type=simple
WorkingDirectory=%I
ExecStart=/usr/bin/node /home/%u/.local/bin/projectmind sync
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

2. Enable for a project:
```bash
systemctl --user daemon-reload
systemctl --user enable --now projectmind-sync@$(systemd-escape /path/to/my-project).service
```

---

## 8. Permissions and Security on Linux

* All files and SQLite databases created by ProjectMind use secure user permissions (`0755` for directories, `0644` for files).
* ProjectMind does not require `root` or `sudo` privileges. Never run `projectmind` as `root`.
* Secret files (`.env`, `.pem`, `.key`, `id_rsa`, `credentials`) are automatically excluded from indexing by the core security engine.

