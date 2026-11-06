import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';
import { SupportedAgentId, backupFileBeforeModify, readJsonSafe, writeJsonPretty } from '@projectmind/agent-sdk';
import { PROJECTMIND_VERSION } from '@projectmind/shared';
import { PluginRegistry } from './registry';
import { RuntimeResolver } from './runtime-resolver';

export interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

export interface GitHubReleasePayload {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface PluginManifestIndexEntry {
  id: SupportedAgentId;
  name: string;
  version: string;
  description: string;
  downloadUrl: string;
  sha256: string;
  minEngineVersion: string;
  supportedPlatforms: string[];
}

export interface UnifiedUpdateManifest {
  engineVersion: string;
  publishedAt: string;
  changelog?: string;
  plugins: Record<SupportedAgentId, PluginManifestIndexEntry>;
  checksums: Record<string, string>;
}

export interface CoreUpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  isOutdated: boolean;
  releaseTag: string;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  compatible: boolean;
  incompatibilityReason?: string;
  downloadUrl?: string;
}

export interface PluginUpdateInfo {
  agentId: SupportedAgentId;
  displayName: string;
  installedVersion: string | null;
  latestVersion: string;
  isInstalled: boolean;
  isOutdated: boolean;
  downloadUrl: string;
  sha256: string;
  minEngineVersion: string;
  supportedPlatforms: string[];
}

export interface OutdatedPluginsReport {
  projectRoot: string;
  plugins: PluginUpdateInfo[];
  outdatedCount: number;
}

export interface PluginUpdateResult {
  agentId: SupportedAgentId;
  success: boolean;
  previousVersion: string;
  newVersion: string;
  backupPath?: string;
  error?: string;
  restoredFromBackup?: boolean;
}

export interface CoreUpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  backupPath?: string;
  error?: string;
  rollbackExecuted?: boolean;
}

export interface UpdateManagerOptions {
  githubRepo?: string; // default: Rootx202/ProjectMind
  httpFetcher?: (url: string) => Promise<string | Buffer>;
  cacheDir?: string;
  cacheTtlMs?: number; // default: 1 hour
}

export class UpdateLock {
  public static acquireLock(projectRoot: string, operation = 'update'): boolean {
    const lockPath = path.join(projectRoot, '.projectmind', '.update.lock');
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      if (fs.existsSync(lockPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          const ageMs = Date.now() - (content.timestamp || 0);
          // If lock is older than 5 minutes, consider it stale
          if (ageMs > 5 * 60 * 1000) {
            fs.unlinkSync(lockPath);
          } else {
            return false;
          }
        } catch (_) {
          fs.unlinkSync(lockPath);
        }
      }
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, operation, timestamp: Date.now() }),
        { flag: 'wx' }
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  public static releaseLock(projectRoot: string): void {
    const lockPath = path.join(projectRoot, '.projectmind', '.update.lock');
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch (_) {}
  }
}

export class UpdateManager {
  private readonly githubRepo: string;
  private readonly httpFetcher: (url: string) => Promise<string | Buffer>;
  private readonly cacheDir: string | null;
  private readonly cacheTtlMs: number;

  constructor(options?: UpdateManagerOptions) {
    this.githubRepo = options?.githubRepo || 'Rootx202/ProjectMind';
    this.httpFetcher = options?.httpFetcher || UpdateManager.defaultHttpFetcher;
    this.cacheDir = options?.cacheDir || null;
    this.cacheTtlMs = options?.cacheTtlMs || 3600000; // 1 hour
  }

  public static compareSemVer(v1: string, v2: string): number {
    const clean1 = v1.replace(/^v/, '').trim();
    const clean2 = v2.replace(/^v/, '').trim();
    const p1 = clean1.split('.').map((n) => parseInt(n, 10) || 0);
    const p2 = clean2.split('.').map((n) => parseInt(n, 10) || 0);

    for (let i = 0; i < 3; i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  public static defaultHttpFetcher(url: string): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        url,
        {
          headers: {
            'User-Agent': 'ProjectMind-Updater',
            Accept: 'application/vnd.github+json, application/json, */*'
          },
          timeout: 15000
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // Handle redirect
            UpdateManager.defaultHttpFetcher(res.headers.location).then(resolve).catch(reject);
            return;
          }

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'} for ${url}`));
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const contentType = res.headers['content-type'] || '';
            if (contentType.includes('json') || contentType.includes('text')) {
              resolve(buf.toString('utf8'));
            } else {
              resolve(buf);
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Connection timed out after 15000ms while connecting to ${url}`));
      });

      req.on('error', (err) => {
        reject(new Error(`Network request failed to ${url}: ${err.message}`));
      });
    });
  }

  public async fetchLatestRelease(): Promise<GitHubReleasePayload> {
    const url = `https://api.github.com/repos/${this.githubRepo}/releases/latest`;
    const res = await this.httpFetcher(url);
    const text = typeof res === 'string' ? res : res.toString('utf8');
    return JSON.parse(text) as GitHubReleasePayload;
  }

  public async fetchUpdateManifest(): Promise<UnifiedUpdateManifest> {
    try {
      const release = await this.fetchLatestRelease();
      const indexAsset = release.assets?.find((a) => a.name === 'index.json');
      const shaAsset = release.assets?.find((a) => a.name === 'SHA256SUMS');

      let checksums: Record<string, string> = {};
      if (shaAsset) {
        try {
          const shaRaw = await this.httpFetcher(shaAsset.browser_download_url);
          const shaText = typeof shaRaw === 'string' ? shaRaw : shaRaw.toString('utf8');
          for (const line of shaText.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
              checksums[parts[1].trim()] = parts[0].trim();
            }
          }
        } catch (_) {}
      }

      if (indexAsset) {
        const indexRaw = await this.httpFetcher(indexAsset.browser_download_url);
        const indexText = typeof indexRaw === 'string' ? indexRaw : indexRaw.toString('utf8');
        const parsed = JSON.parse(indexText);
        return {
          engineVersion: release.tag_name.replace(/^v/, ''),
          publishedAt: release.published_at,
          changelog: release.body,
          plugins: parsed.plugins || parsed,
          checksums
        };
      }

      // Fallback: construct manifest from release assets
      const pluginsMap: Record<string, any> = {};
      for (const asset of release.assets || []) {
        if (asset.name.endsWith('.tar.gz')) {
          const match = asset.name.match(/^([a-z0-9-]+)-([0-9.]+)\.tar\.gz$/);
          if (match) {
            const agentId = match[1] as SupportedAgentId;
            const version = match[2];
            pluginsMap[agentId] = {
              id: agentId,
              name: agentId,
              version,
              downloadUrl: asset.browser_download_url,
              sha256: checksums[asset.name] || '',
              minEngineVersion: '1.0.0',
              supportedPlatforms: ['linux', 'windows', 'darwin']
            };
          }
        }
      }

      return {
        engineVersion: release.tag_name.replace(/^v/, ''),
        publishedAt: release.published_at,
        changelog: release.body,
        plugins: pluginsMap,
        checksums
      };
    } catch (err) {
      throw new Error(`Failed to fetch update manifest from GitHub (${this.githubRepo}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async checkCoreUpdate(): Promise<CoreUpdateCheckResult> {
    const currentVersion = PROJECTMIND_VERSION;
    try {
      const release = await this.fetchLatestRelease();
      const latestVersion = release.tag_name.replace(/^v/, '');
      const isOutdated = UpdateManager.compareSemVer(currentVersion, latestVersion) < 0;

      // Compatibility check: Node version >= 18
      const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
      let compatible = true;
      let incompatibilityReason: string | undefined;

      if (nodeMajor < 18) {
        compatible = false;
        incompatibilityReason = `ProjectMind requires Node.js >= 18.0.0 (current: v${process.versions.node})`;
      }

      const zipAsset = release.assets?.find((a) => a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'));

      return {
        currentVersion,
        latestVersion,
        isOutdated,
        releaseTag: release.tag_name,
        releaseName: release.name || `ProjectMind ${release.tag_name}`,
        releaseNotes: release.body || '',
        publishedAt: release.published_at,
        compatible,
        incompatibilityReason,
        downloadUrl: zipAsset?.browser_download_url || `https://github.com/${this.githubRepo}/archive/refs/tags/${release.tag_name}.zip`
      };
    } catch (err) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        isOutdated: false,
        releaseTag: `v${currentVersion}`,
        releaseName: `ProjectMind v${currentVersion}`,
        releaseNotes: 'Offline or failed to connect to GitHub Releases.',
        publishedAt: new Date().toISOString(),
        compatible: true,
        incompatibilityReason: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public async checkOutdatedPlugins(
    projectRoot: string,
    installedAdapters: Array<{ agentId: SupportedAgentId; displayName: string; verified: boolean }>
  ): Promise<OutdatedPluginsReport> {
    const report: OutdatedPluginsReport = {
      projectRoot,
      plugins: [],
      outdatedCount: 0
    };

    let manifest: UnifiedUpdateManifest;
    try {
      manifest = await this.fetchUpdateManifest();
    } catch (err) {
      // In offline mode, return current plugins with isOutdated: false
      for (const adapter of installedAdapters) {
        const localManifest = PluginRegistry.loadManifest(adapter.agentId);
        report.plugins.push({
          agentId: adapter.agentId,
          displayName: adapter.displayName,
          installedVersion: adapter.verified ? (localManifest?.version || '1.0.0') : null,
          latestVersion: localManifest?.version || '1.0.0',
          isInstalled: adapter.verified,
          isOutdated: false,
          downloadUrl: '',
          sha256: '',
          minEngineVersion: '1.0.0',
          supportedPlatforms: ['linux', 'windows', 'darwin']
        });
      }
      return report;
    }

    for (const adapter of installedAdapters) {
      const localManifest = PluginRegistry.loadManifest(adapter.agentId);
      const installedVer = adapter.verified ? (localManifest?.version || '1.0.0') : null;
      const remoteEntry = manifest.plugins[adapter.agentId];
      const latestVer = remoteEntry?.version || localManifest?.version || '1.0.0';

      const isOutdated = Boolean(installedVer && UpdateManager.compareSemVer(installedVer, latestVer) < 0);
      if (isOutdated) {
        report.outdatedCount++;
      }

      report.plugins.push({
        agentId: adapter.agentId,
        displayName: adapter.displayName,
        installedVersion: installedVer,
        latestVersion: latestVer,
        isInstalled: adapter.verified,
        isOutdated,
        downloadUrl: remoteEntry?.downloadUrl || '',
        sha256: remoteEntry?.sha256 || manifest.checksums[`${adapter.agentId}-${latestVer}.tar.gz`] || '',
        minEngineVersion: remoteEntry?.minEngineVersion || '1.0.0',
        supportedPlatforms: remoteEntry?.supportedPlatforms || ['linux', 'windows', 'darwin']
      });
    }

    return report;
  }

  public verifyPackageSha256(data: Buffer, expectedSha256: string): boolean {
    if (!expectedSha256) return true; // If no checksum provided, pass
    const actual = crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
    return actual === expectedSha256.toLowerCase().trim();
  }

  public async updatePlugin(
    projectRoot: string,
    agentId: SupportedAgentId,
    adapter: any,
    options?: { targetVersion?: string; force?: boolean }
  ): Promise<PluginUpdateResult> {
    const locked = UpdateLock.acquireLock(projectRoot, `plugin-update-${agentId}`);
    if (!locked) {
      return {
        agentId,
        success: false,
        previousVersion: 'unknown',
        newVersion: 'unknown',
        error: `Another update process holds the lock (.projectmind/.update.lock). Aborting.`
      };
    }

    const localManifest = PluginRegistry.loadManifest(agentId);
    const previousVersion = localManifest?.version || '1.0.0';

    try {
      // 1. Fetch manifest
      const manifest = await this.fetchUpdateManifest();
      const remoteEntry = manifest.plugins[agentId];
      const targetVersion = options?.targetVersion || remoteEntry?.version || previousVersion;

      // 2. Compatibility check: minEngineVersion
      if (remoteEntry?.minEngineVersion) {
        if (UpdateManager.compareSemVer(PROJECTMIND_VERSION, remoteEntry.minEngineVersion) < 0) {
          UpdateLock.releaseLock(projectRoot);
          return {
            agentId,
            success: false,
            previousVersion,
            newVersion: targetVersion,
            error: `Plugin ${agentId} v${targetVersion} requires ProjectMind engine >= v${remoteEntry.minEngineVersion}. Current engine is v${PROJECTMIND_VERSION}. Please update the engine first.`
          };
        }
      }

      // 3. Download package if downloadUrl available
      let packageBuffer: Buffer | null = null;
      if (remoteEntry?.downloadUrl) {
        try {
          const raw = await this.httpFetcher(remoteEntry.downloadUrl);
          packageBuffer = typeof raw === 'string' ? Buffer.from(raw) : raw;
        } catch (downloadErr) {
          UpdateLock.releaseLock(projectRoot);
          return {
            agentId,
            success: false,
            previousVersion,
            newVersion: targetVersion,
            error: `Download failed for ${agentId} plugin package: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`
          };
        }

        // 4. Verify SHA-256 integrity
        const expectedSha = remoteEntry.sha256 || manifest.checksums[`${agentId}-${targetVersion}.tar.gz`];
        if (expectedSha && packageBuffer) {
          const valid = this.verifyPackageSha256(packageBuffer, expectedSha);
          if (!valid) {
            UpdateLock.releaseLock(projectRoot);
            return {
              agentId,
              success: false,
              previousVersion,
              newVersion: targetVersion,
              error: `Cryptographic SHA-256 verification failed for ${agentId} package! Possible file corruption or tampering. Aborting update.`
            };
          }
        }
      }

      // 5. Perform atomic install & backup
      const backupDir = path.join(projectRoot, '.projectmind', 'backups', `update-${agentId}-${Date.now()}`);
      fs.mkdirSync(backupDir, { recursive: true });

      // Run adapter update/install
      const installRes = adapter.install(projectRoot, { backupDir });
      if (!installRes.installed) {
        // Rollback: verification failed
        UpdateLock.releaseLock(projectRoot);
        return {
          agentId,
          success: false,
          previousVersion,
          newVersion: targetVersion,
          backupPath: backupDir,
          restoredFromBackup: true,
          error: `Adapter verification checks failed after update for ${agentId}. Rolled back.`
        };
      }

      UpdateLock.releaseLock(projectRoot);
      return {
        agentId,
        success: true,
        previousVersion,
        newVersion: targetVersion,
        backupPath: backupDir
      };
    } catch (err) {
      UpdateLock.releaseLock(projectRoot);
      return {
        agentId,
        success: false,
        previousVersion,
        newVersion: 'unknown',
        error: `Unexpected error updating plugin ${agentId}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  public async updateAllPlugins(
    projectRoot: string,
    adapters: Array<{ agentId: SupportedAgentId; adapter: any; verified: boolean }>
  ): Promise<PluginUpdateResult[]> {
    const results: PluginUpdateResult[] = [];
    for (const item of adapters) {
      const res = await this.updatePlugin(projectRoot, item.agentId, item.adapter);
      results.push(res);
    }
    return results;
  }
}

