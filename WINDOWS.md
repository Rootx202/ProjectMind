# ProjectMind on Microsoft Windows

This guide covers running, configuring, and troubleshooting ProjectMind natively on Microsoft Windows 10, Windows 11, and Windows Server environments.

---

## 1. Native Windows Prerequisites

* **Node.js**: `v18.0.0` or higher (x64 or ARM64). Download the Windows installer (`.msi`) from [nodejs.org](https://nodejs.org/).
* **PowerShell**: Windows PowerShell 5.1 (built into Windows) or PowerShell 7+ (Core).
* **Terminal**: Windows Terminal (recommended) or PowerShell Console / Command Prompt.

---

## 2. Windows Installation

Run PowerShell as your standard user (administrator is not required):

```powershell
# Run the ProjectMind PowerShell installer
.\install.ps1
```

If PowerShell blocks script execution due to execution policy:

```powershell
# Temporarily allow script execution in the current process only
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

### Installation Target & Wrapper Scripts

`install.ps1` automatically creates:
1. `%LOCALAPPDATA%\ProjectMind` (default runtime folder).
2. `%LOCALAPPDATA%\ProjectMind\bin\projectmind.cmd` (Command Prompt wrapper).
3. `%LOCALAPPDATA%\ProjectMind\bin\projectmind.ps1` (PowerShell wrapper).
4. Adds `%LOCALAPPDATA%\ProjectMind\bin` to your **User PATH** environment variable.

After installation, restart your terminal to reload `%PATH%`, then test:

```powershell
projectmind version
projectmind plugin doctor
```

---

## 3. Path Handling & Cross-Platform Compatibility

ProjectMind is engineered with complete Windows filesystem support:

### Drive Letters & Backslashes
Both forward slashes (`/`) and Windows backslashes (`\`) are normalized transparently using `node:path`. Paths such as `D:\Workspace\MyProject` are fully supported:

```powershell
projectmind plugin install antigravity --project-root "D:\Workspace\MyProject"
```

### Paths with Spaces
Paths containing spaces (e.g. `C:\Users\John Doe\My AI Projects\WebApp`) are handled safely using proper quoting without shell string splitting:

```powershell
projectmind plugin install cursor --project-root "C:\Users\John Doe\My AI Projects\WebApp"
```

### Unicode Directory Names
ProjectMind supports directory names with international Unicode characters (Arabic, Japanese, German umlauts, etc.):

```powershell
projectmind plugin install opencode --project-root "C:\Projects\مشروع_الذكاء"
```

### UNC Network Shares
UNC paths (`\\server\share\repository`) are handled through standard Node.js UNC resolution.

### Windows Long Path Support (> 260 characters)
To prevent Windows `MAX_PATH` limitations in deep nested directories:
1. Open PowerShell as Administrator.
2. Run:
   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```

---

## 4. Terminal Encoding (UTF-8)

To ensure symbols (like checkmarks `✓` and tables) render correctly in Command Prompt or older PowerShell consoles, enable UTF-8 code page:

```cmd
chcp 65001
```

In Windows Terminal, UTF-8 is enabled by default.

---

## 5. Antivirus & Windows Defender Exclusions

ProjectMind stores project memory and knowledge indexes in a local SQLite3 database located at:
`<project-root>\.projectmind\projectmind.db`

Some aggressive antivirus solutions or Windows Defender Real-Time Protection can lock SQLite journal files (`projectmind.db-wal` or `projectmind.db-shm`) during high-frequency index synchronization.

If you encounter `EBUSY: resource busy or locked` errors:
1. Open Windows Security -> Virus & threat protection settings.
2. Under **Exclusions**, add an exclusion for:
   * File extension: `.db`, `.db-wal`, `.db-shm`
   * Or directory: your active development workspaces folder.

---

## 6. Running with Windows Subsystem for Linux (WSL2)

If you develop inside WSL2 (Ubuntu / Debian / Kali):
* Install ProjectMind inside WSL using `./install.sh`.
* Windows agents (like Cursor or VS Code) running on the Windows host connecting via the WSL Remote extension will communicate seamlessly with ProjectMind's local MCP server inside WSL.
* Avoid running Windows-side ProjectMind against `\\wsl$\` shares directly; instead, run ProjectMind natively inside the Linux distribution for optimal SQLite I/O performance.

---

## 7. Windows Command Quick Reference

| Task | PowerShell Command |
| :--- | :--- |
| **Check Doctor / Diagnostics** | `projectmind plugin doctor` |
| **List Installed Plugins** | `projectmind plugin list` |
| **Install Antigravity** | `projectmind plugin install antigravity` |
| **Install Cursor** | `projectmind plugin install cursor` |
| **Install All Plugins** | `projectmind plugin install --all` |
| **Verify Integrations** | `projectmind plugin verify --all` |
| **Uninstall Integration** | `projectmind plugin uninstall cursor` |

