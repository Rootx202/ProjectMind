import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { PlatformId } from './types';
import { SupportedAgentId } from '@projectmind/agent-sdk';

export interface OsDirectoryLayout {
  platform: PlatformId;
  homeDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  binDir: string;
}

export function detectPlatform(): PlatformId {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}

export function getOsDirectoryLayout(customHomeDir?: string): OsDirectoryLayout {
  const platform = detectPlatform();
  const homeDir = customHomeDir || os.homedir();

  if (platform === 'windows') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return {
      platform,
      homeDir,
      configDir: path.join(appData, 'ProjectMind'),
      dataDir: path.join(localAppData, 'ProjectMind', 'data'),
      cacheDir: path.join(localAppData, 'ProjectMind', 'cache'),
      binDir: path.join(localAppData, 'ProjectMind', 'bin')
    };
  }

  if (platform === 'darwin') {
    const appSupport = path.join(homeDir, 'Library', 'Application Support');
    const caches = path.join(homeDir, 'Library', 'Caches');
    return {
      platform,
      homeDir,
      configDir: path.join(appSupport, 'ProjectMind'),
      dataDir: path.join(appSupport, 'ProjectMind', 'data'),
      cacheDir: path.join(caches, 'ProjectMind'),
      binDir: path.join(homeDir, '.local', 'bin')
    };
  }

  // Linux and standard POSIX (XDG Base Directory Specification)
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const xdgData = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache');

  return {
    platform,
    homeDir,
    configDir: path.join(xdgConfig, 'projectmind'),
    dataDir: path.join(xdgData, 'projectmind'),
    cacheDir: path.join(xdgCache, 'projectmind'),
    binDir: path.join(homeDir, '.local', 'bin')
  };
}

export function getAgentGlobalConfigCandidates(agentId: SupportedAgentId, customHomeDir?: string): string[] {
  const layout = getOsDirectoryLayout(customHomeDir);
  const home = layout.homeDir;
  const platform = layout.platform;

  switch (agentId) {
    case 'antigravity':
      return [
        path.join(home, '.agents'),
        path.join(home, '.gemini', 'config'),
        path.join(home, '.antigravity')
      ];
    case 'claude-code':
      return [
        path.join(home, '.claude'),
        path.join(home, '.config', 'claude'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'Claude')] : [])
      ].filter(Boolean);
    case 'codex':
      return [
        path.join(home, '.codex'),
        path.join(home, '.config', 'codex'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'Codex')] : [])
      ].filter(Boolean);
    case 'cursor':
      return [
        path.join(home, '.cursor'),
        path.join(home, '.config', 'Cursor'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'Cursor')] : [])
      ].filter(Boolean);
    case 'gemini-cli':
      return [
        path.join(home, '.gemini'),
        path.join(home, '.config', 'gemini')
      ];
    case 'github-copilot':
      return [
        path.join(home, '.vscode'),
        path.join(home, '.config', 'github-copilot'),
        path.join(home, '.config', 'Code'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'Code')] : [])
      ].filter(Boolean);
    case 'opencode':
      return [
        path.join(home, '.config', 'opencode'),
        path.join(home, '.opencode'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'opencode')] : [])
      ].filter(Boolean);
    case 'hermes-agent':
      return [
        path.join(home, '.hermes'),
        path.join(home, '.config', 'hermes'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'hermes')] : [])
      ].filter(Boolean);
    case 'deepseek-harness':
      return [
        path.join(home, '.dsh'),
        path.join(home, '.deepseek'),
        path.join(home, '.config', 'dsh'),
        ...(platform === 'windows' ? [path.join(process.env.APPDATA || '', 'dsh')] : [])
      ].filter(Boolean);
  }
}

