import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import { URL } from 'node:url';
import {
  SupportedAgentId,
  AdapterInstallOptions,
  loadPluginAssets,
  setActivePluginAssets,
  clearActivePluginAssets,
  readJsonSafe,
  writeJsonPretty
} from '@projectmind/agent-sdk';
import { PROJECTMIND_VERSION, atomicWriteFileSync } from '@projectmind/shared';
import { PluginRegistry } from './registry';
import { extractTarGz, DEFAULT_EXTRACT_LIMITS, ArchiveSecurityError } from './tar';

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
  plugins: Record<string, PluginManifestIndexEntry>;
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
  sha256?: string;
  artifactName?: string;
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
  checksumAvailable: boolean;
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
  rollbackExecuted?: boolean;
  artifactSha256?: string;
  installedPackageDir?: string;
  installedFromPackage?: boolean;
}

export interface CoreUpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  backupPath?: string;
  error?: string;
  rollbackExecuted?: boolean;
  stagedDir?: string;
  artifactSha256?: string;
}

export interface UpdateManagerOptions {
  githubRepo?: string;
  httpFetcher?: (url: string) => Promise<string | Buffer>;
  cacheDir?: string;
  cacheTtlMs?: number;
  /** Hard cap for any downloaded artifact. */
  maxDownloadBytes?: number;
  /** Explicit opt-in for insecure/unsigned development flows only. */
  allowInsecureHttp?: boolean;
  /** Explicit opt-in to accept missing checksums (never for production). */
  allowMissingChecksum?: boolean;
  trustedHosts?: string[];
}

const DEFAULT_TRUSTED_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org'
];

export class UpdateLock {
  public static acquireLock(projectRoot: string, operation = 'update'): boolean {
    const lockPath = path.join(projectRoot, '.projectmind', '.update.lock');
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      if (fs.existsSync(lockPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          const ageMs = Date.now() - (content.timestamp || 0);
          if (ageMs > 5 * 60 * 1000) fs.unlinkSync(lockPath);
          else return false;
        } catch (_) {
          fs.unlinkSync(lockPath);
        }
      }
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, operation, timestamp: Date.now() }), { flag: 'wx' });
      return true;
    } catch (_) {
      return false;
    }
  }

  public static releaseLock(projectRoot: string): void {
    const lockPath = path.join(projectRoot, '.projectmind', '.update.lock');
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (_) {}
  }
}

export class UpdateManager {
  private readonly githubRepo: string;
  private readonly httpFetcher: (url: string) => Promise<string | Buffer>;
  private readonly cacheDir: string | null;
  private readonly cacheTtlMs: number;
  private readonly maxDownloadBytes: number;
  private readonly allowInsecureHttp: boolean;
  private readonly allowMissingChecksum: boolean;
  private readonly trustedHosts: string[];

  constructor(options?: UpdateManagerOptions) {
    this.githubRepo = options?.githubRepo || 'Rootx202/ProjectMind';
    this.httpFetcher = options?.httpFetcher || UpdateManager.defaultHttpFetcher;
    this.cacheDir = options?.cacheDir || null;
    this.cacheTtlMs = options?.cacheTtlMs || 3600000;
    this.maxDownloadBytes = options?.maxDownloadBytes || 64 * 1024 * 1024;
    this.allowInsecureHttp = options?.allowInsecureHttp ?? process.env.PROJECTMIND_ALLOW_INSECURE_UPDATES === '1';
    this.allowMissingChecksum = options?.allowMissingChecksum ?? process.env.PROJECTMIND_ALLOW_UNVERIFIED_UPDATES === '1';
    this.trustedHosts = options?.trustedHosts || DEFAULT_TRUSTED_HOSTS;
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

  public assertSecureUrl(rawUrl: string, trustedHosts?: string[]): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      throw new Error(`Invalid update URL: ${rawUrl}`);
    }
    if (parsed.protocol !== 'https:') {
      if (!this.allowInsecureHttp) {
        throw new Error(`Refusing insecure update URL (${parsed.protocol}). HTTPS is required; set PROJECTMIND_ALLOW_INSECURE_UPDATES=1 only for local testing.`);
      }
    }
    const hosts = trustedHosts || this.trustedHosts;
    const hostname = parsed.hostname.toLowerCase();
    if (!hosts.includes(hostname)) {
      throw new Error(`Refusing update from untrusted host "${hostname}". Allowed hosts: ${hosts.join(', ')}`);
    }
    return parsed;
  }

  public static defaultHttpFetcher(url: string): Promise<string | Buffer> {
    return UpdateManager.httpGetBuffer(url, 0).then(({ buffer, contentType }) => {
      if (/json|text|xml/i.test(contentType)) return buffer.toString('utf8');
      return buffer;
    });
  }

  private static httpGetBuffer(url: string, redirects: number): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(new Error(`Invalid update URL: ${url}`));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new Error(`Refusing insecure update URL (${parsed.protocol}). HTTPS is required.`));
        return;
      }
      const allowed = DEFAULT_TRUSTED_HOSTS;
      if (!allowed.includes(parsed.hostname.toLowerCase())) {
        reject(new Error(`Refusing redirect/download to untrusted host "${parsed.hostname}"`));
        return;
      }

      const req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'ProjectMind-Updater',
            Accept: 'application/vnd.github+json, application/json, application/octet-stream, */*'
          },
          timeout: 20000
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 3) {
              reject(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            let next: string;
            try {
              next = new URL(res.headers.location, url).toString();
            } catch (_) {
              reject(new Error(`Invalid redirect location from ${url}`));
              return;
            }
            UpdateManager.httpGetBuffer(next, redirects + 1).then(resolve).catch(reject);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status}: ${res.statusMessage || 'Request failed'} for ${url}`));
            return;
          }

          const declared = Number(res.headers['content-length'] || 0);
          const maxBytes = 64 * 1024 * 1024;
          if (declared > maxBytes) {
            res.resume();
            reject(new Error(`Refusing download larger than ${maxBytes} bytes (${declared} declared)`));
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk) => {
            const buf = Buffer.from(chunk);
            received += buf.length;
            if (received > maxBytes) {
              req.destroy();
              reject(new Error(`Download exceeded ${maxBytes} bytes; aborted`));
              return;
            }
            chunks.push(buf);
          });
          res.on('end', () => {
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: String(res.headers['content-type'] || ''),
              finalUrl: url
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Connection timed out after 20000ms while connecting to ${url}`));
      });
      req.on('error', (err) => reject(new Error(`Network request failed to ${url}: ${err.message}`)));
    });
  }

  public async fetchLatestRelease(): Promise<GitHubReleasePayload> {
    const url = `https://api.github.com/repos/${this.githubRepo}/releases/latest`;
    this.assertSecureUrl(url, ['api.github.com']);
    const res = await this.httpFetcher(url);
    const text = typeof res === 'string' ? res : res.toString('utf8');
    const parsed = JSON.parse(text) as GitHubReleasePayload;
    if (!parsed || typeof parsed.tag_name !== 'string') {
      throw new Error('GitHub release response is missing tag_name');
    }
    parsed.assets = Array.isArray(parsed.assets) ? parsed.assets : [];
    return parsed;
  }

  public async fetchUpdateManifest(): Promise<UnifiedUpdateManifest> {
    try {
      const release = await this.fetchLatestRelease();
      const indexAsset = release.assets.find((a) => String(a.name) === 'index.json');
      const shaAsset = release.assets.find((a) => String(a.name) === 'SHA256SUMS');

      const checksums: Record<string, string> = {};
      if (shaAsset) {
        const shaRaw = await this.httpFetcher(shaAsset.browser_download_url);
        const shaText = typeof shaRaw === 'string' ? shaRaw : shaRaw.toString('utf8');
        for (const line of shaText.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^[a-f0-9]{64}$/i.test(parts[0])) {
            const name = parts[1].replace(/^\*/, '').trim();
            checksums[name] = parts[0].toLowerCase();
            checksums[name.split('/').pop() as string] = parts[0].toLowerCase();
          }
        }
      }

      if (indexAsset) {
        const indexRaw = await this.httpFetcher(indexAsset.browser_download_url);
        const indexText = typeof indexRaw === 'string' ? indexRaw : indexRaw.toString('utf8');
        const parsed = JSON.parse(indexText);
        return {
          engineVersion: String(parsed.engineVersion || release.tag_name.replace(/^v/, '')),
          publishedAt: String(parsed.publishedAt || release.published_at),
          changelog: release.body,
          plugins: parsed.plugins || {},
          checksums: { ...checksums, ...(parsed.checksums || {}) }
        };
      }

      const pluginsMap: Record<string, PluginManifestIndexEntry> = {};
      for (const asset of release.assets) {
        const name = String(asset.name);
        const match = name.match(/^([a-z0-9-]+)-([0-9.]+)\.tar\.gz$/);
        if (!match) continue;
        const agentId = match[1] as SupportedAgentId;
        const version = match[2];
        pluginsMap[agentId] = {
          id: agentId,
          name: agentId,
          version,
          description: '',
          downloadUrl: asset.browser_download_url,
          sha256: checksums[name] || '',
          minEngineVersion: '1.0.0',
          supportedPlatforms: ['linux', 'windows', 'darwin']
        };
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

      const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
      let compatible = true;
      let incompatibilityReason: string | undefined;
      if (nodeMajor < 18) {
        compatible = false;
        incompatibilityReason = `ProjectMind requires Node.js >= 18.0.0 (current: v${process.versions.node})`;
      }

      const artifact = release.assets.find((a) => String(a.name) === 'projectmind-full.tar.gz')
        || release.assets.find((a) => String(a.name).endsWith('.tar.gz') && String(a.name).includes('projectmind'));
      let sha256 = '';
      const shaAsset = release.assets.find((a) => String(a.name) === 'SHA256SUMS');
      if (shaAsset && artifact) {
        try {
          const raw = await this.httpFetcher(shaAsset.browser_download_url);
          const text = typeof raw === 'string' ? raw : raw.toString('utf8');
          for (const line of text.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2 && parts[1].replace(/^\*/, '').split('/').pop() === String(artifact.name) && /^[a-f0-9]{64}$/i.test(parts[0])) {
              sha256 = parts[0].toLowerCase();
            }
          }
        } catch (_) {}
      }

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
        downloadUrl: artifact?.browser_download_url || `https://github.com/${this.githubRepo}/archive/refs/tags/${release.tag_name}.tar.gz`,
        sha256: sha256 || undefined,
        artifactName: artifact ? String(artifact.name) : undefined
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
    const report: OutdatedPluginsReport = { projectRoot, plugins: [], outdatedCount: 0 };

    let manifest: UnifiedUpdateManifest;
    try {
      manifest = await this.fetchUpdateManifest();
    } catch (_) {
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
          supportedPlatforms: ['linux', 'windows', 'darwin'],
          checksumAvailable: false
        });
      }
      return report;
    }

    for (const adapter of installedAdapters) {
      const localManifest = PluginRegistry.loadManifest(adapter.agentId);
      const installedVer = adapter.verified ? (localManifest?.version || '1.0.0') : null;
      const remoteEntry = manifest.plugins[adapter.agentId];
      const latestVer = remoteEntry?.version || localManifest?.version || '1.0.0';
      const sha = remoteEntry?.sha256 || manifest.checksums[`${adapter.agentId}-${latestVer}.tar.gz`] || '';
      const isOutdated = Boolean(installedVer && UpdateManager.compareSemVer(installedVer, latestVer) < 0);
      if (isOutdated) report.outdatedCount++;

      report.plugins.push({
        agentId: adapter.agentId,
        displayName: adapter.displayName,
        installedVersion: installedVer,
        latestVersion: latestVer,
        isInstalled: adapter.verified,
        isOutdated,
        downloadUrl: remoteEntry?.downloadUrl || '',
        sha256: sha,
        minEngineVersion: remoteEntry?.minEngineVersion || '1.0.0',
        supportedPlatforms: remoteEntry?.supportedPlatforms || ['linux', 'windows', 'darwin'],
        checksumAvailable: Boolean(sha)
      });
    }

    return report;
  }

  public verifyPackageSha256(
    data: Buffer,
    expectedSha256: string,
    options?: { allowMissing?: boolean }
  ): boolean {
    if (!expectedSha256 || !expectedSha256.trim()) {
      return Boolean(options?.allowMissing ?? this.allowMissingChecksum);
    }
    const normalized = expectedSha256.trim().toLowerCase().replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(normalized, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  public async stagePluginPackage(
    projectRoot: string,
    agentId: SupportedAgentId,
    targetVersion: string,
    archive: Buffer,
    expectedSha256: string
  ): Promise<{
    stagingDir: string;
    packageDir: string;
    manifest: Record<string, unknown>;
    files: string[];
  }> {
    if (!this.verifyPackageSha256(archive, expectedSha256)) {
      throw new Error('SHA-256 verification failed for the downloaded plugin archive');
    }
    const stagingRoot = path.join(projectRoot, '.projectmind', 'staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    const stagingDir = path.join(stagingRoot, `plugin-${agentId}-${targetVersion}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    let extracted;
    try {
      extracted = extractTarGz(archive, stagingDir, {
        maxEntries: 256,
        maxTotalBytes: 24 * 1024 * 1024,
        maxFileBytes: 8 * 1024 * 1024
      });
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (err instanceof ArchiveSecurityError) throw err;
      throw new Error(`Failed to extract plugin archive: ${err instanceof Error ? err.message : String(err)}`);
    }

    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error('Plugin archive is missing manifest.json');
    }
    let manifest: Record<string, any>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Plugin archive manifest.json is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (String(manifest.id) !== agentId) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Plugin archive id "${manifest.id}" does not match requested agent "${agentId}"`);
    }
    if (String(manifest.version) !== targetVersion) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Plugin archive version "${manifest.version}" does not match requested version "${targetVersion}"`);
    }
    if (manifest.minEngineVersion && UpdateManager.compareSemVer(PROJECTMIND_VERSION, String(manifest.minEngineVersion)) < 0) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Plugin v${targetVersion} requires engine >= v${manifest.minEngineVersion}`);
    }

    const listed = Array.isArray(manifest.files) ? manifest.files : [];
    if (listed.length === 0) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error('Plugin archive manifest must list every file with its SHA-256');
    }
    const listedPaths = new Set<string>();
    for (const file of listed) {
      if (!file || typeof file.path !== 'string') continue;
      const rel = String(file.path).replace(/\\/g, '/').replace(/^\.\//, '');
      if (rel === 'manifest.json' || rel.includes('..') || path.isAbsolute(rel)) {
        throw new Error(`Plugin archive manifest contains an unsafe path: ${rel}`);
      }
      const full = path.join(stagingDir, rel);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new Error(`Plugin archive is missing declared file: ${rel}`);
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (String(file.sha256 || '').toLowerCase() !== actual) {
        throw new Error(`Plugin file hash mismatch for ${rel}`);
      }
      listedPaths.add(rel);
    }
    for (const extractedFile of extracted.files) {
      if (extractedFile === 'manifest.json') continue;
      if (!listedPaths.has(extractedFile)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw new Error(`Plugin archive contains undeclared file: ${extractedFile}`);
      }
    }

    return { stagingDir, packageDir: stagingDir, manifest, files: extracted.files.sort() };
  }

  public installPluginPackage(
    projectRoot: string,
    agentId: SupportedAgentId,
    version: string,
    stagingDir: string,
    artifactSha256: string,
    manifest: Record<string, unknown>,
    files: string[]
  ): { packageDir: string; previousVersion: string | null; previousPackageDir: string | null; statePath: string } {
    const pluginRoot = path.join(projectRoot, '.projectmind', 'plugins', agentId);
    const versionsDir = path.join(pluginRoot, 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });
    const dest = path.join(versionsDir, version);
    const statePath = path.join(pluginRoot, 'state.json');
    const previousState = readJsonSafe(statePath);
    const previousVersion = previousState.currentVersion ? String(previousState.currentVersion) : null;
    const previousPackageDir = previousState.currentPackageDir ? String(previousState.currentPackageDir) : null;

    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    try {
      fs.renameSync(stagingDir, dest);
    } catch (err) {
      // Cross-device fallback.
      fs.mkdirSync(dest, { recursive: true });
      for (const rel of files) {
        const src = path.join(stagingDir, rel);
        const dst = path.join(dest, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    atomicWriteFileSync(statePath, JSON.stringify({
      agentId,
      currentVersion: version,
      currentPackageDir: dest,
      previousVersion,
      previousPackageDir,
      artifactSha256,
      files,
      manifest,
      installedAt: new Date().toISOString()
    }, null, 2) + '\n');

    return { packageDir: dest, previousVersion, previousPackageDir, statePath };
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
        agentId, success: false, previousVersion: 'unknown', newVersion: 'unknown',
        error: 'Another update process holds the lock (.projectmind/.update.lock). Aborting.'
      };
    }

    const localManifest = PluginRegistry.loadManifest(agentId);
    const previousVersion = localManifest?.version || '1.0.0';
    const backupDir = path.join(projectRoot, '.projectmind', 'backups', `update-${agentId}-${Date.now()}`);

    try {
      const manifest = await this.fetchUpdateManifest();
      const remoteEntry = manifest.plugins[agentId];
      if (!remoteEntry) {
        return { agentId, success: false, previousVersion, newVersion: previousVersion, error: `No published package found for plugin "${agentId}" in the release index.` };
      }
      const targetVersion = options?.targetVersion || remoteEntry.version;
      if (!options?.force && UpdateManager.compareSemVer(previousVersion, targetVersion) >= 0) {
        return { agentId, success: true, previousVersion, newVersion: previousVersion, error: undefined };
      }

      if (!remoteEntry.downloadUrl) {
        return { agentId, success: false, previousVersion, newVersion: targetVersion, error: 'Release index does not provide a download URL for this plugin.' };
      }
      if (remoteEntry.minEngineVersion && UpdateManager.compareSemVer(PROJECTMIND_VERSION, remoteEntry.minEngineVersion) < 0) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: `Plugin ${agentId} v${targetVersion} requires ProjectMind engine >= v${remoteEntry.minEngineVersion}. Current engine is v${PROJECTMIND_VERSION}. Please update the engine first.`
        };
      }
      this.assertSecureUrl(remoteEntry.downloadUrl);

      const expectedSha = remoteEntry.sha256 || manifest.checksums[`${agentId}-${targetVersion}.tar.gz`];
      if (!expectedSha) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: 'Missing SHA-256 checksum for the plugin package. Refusing to install an unverifiable artifact.'
        };
      }

      let raw: string | Buffer;
      try {
        raw = await this.httpFetcher(remoteEntry.downloadUrl);
      } catch (downloadErr) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: `Download failed for ${agentId} plugin package: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`
        };
      }
      const archive = typeof raw === 'string' ? Buffer.from(raw) : raw;
      if (archive.length > this.maxDownloadBytes) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: `Downloaded plugin package exceeds the ${this.maxDownloadBytes} byte limit.`
        };
      }
      if (!this.verifyPackageSha256(archive, expectedSha)) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: 'Cryptographic SHA-256 verification failed for the plugin package! Possible corruption or tampering. Aborting update.'
        };
      }

      let staged;
      try {
        staged = await this.stagePluginPackage(projectRoot, agentId, targetVersion, archive, expectedSha);
      } catch (err) {
        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          error: `Plugin package validation failed: ${err instanceof Error ? err.message : String(err)}`
        };
      }

      const installed = this.installPluginPackage(
        projectRoot, agentId, targetVersion, staged.stagingDir, expectedSha, staged.manifest, staged.files
      );

      fs.mkdirSync(backupDir, { recursive: true });
      const installOptions: AdapterInstallOptions = {
        backupDir,
        packageDir: installed.packageDir,
        packageVersion: targetVersion
      };

      setActivePluginAssets(loadPluginAssets(installed.packageDir));
      let installRes: any;
      try {
        installRes = adapter.install(projectRoot, installOptions);
      } finally {
        clearActivePluginAssets();
      }

      if (!installRes || !installRes.installed) {
        // Restore the previous package pointer and re-run the installer with it.
        let rollbackExecuted = false;
        try {
          const statePath = path.join(projectRoot, '.projectmind', 'plugins', agentId, 'state.json');
          atomicWriteFileSync(statePath, JSON.stringify({
            agentId,
            currentVersion: installed.previousVersion,
            currentPackageDir: installed.previousPackageDir,
            previousVersion: targetVersion,
            packageRolledBackAt: new Date().toISOString()
          }, null, 2) + '\n');
          if (installed.previousPackageDir && fs.existsSync(installed.previousPackageDir)) {
            setActivePluginAssets(loadPluginAssets(installed.previousPackageDir));
            try {
              adapter.install(projectRoot, { backupDir, packageDir: installed.previousPackageDir, packageVersion: installed.previousVersion });
            } finally {
              clearActivePluginAssets();
            }
          }
          rollbackExecuted = true;
        } catch (_) {}

        return {
          agentId, success: false, previousVersion, newVersion: targetVersion,
          backupPath: backupDir, restoredFromBackup: true, rollbackExecuted,
          artifactSha256: expectedSha, installedPackageDir: installed.packageDir,
          error: `Adapter verification failed after installing the verified package. ${rollbackExecuted ? 'Previous package restored.' : 'Rollback incomplete.'}`
        };
      }

      return {
        agentId, success: true, previousVersion, newVersion: targetVersion,
        backupPath: backupDir, artifactSha256: expectedSha,
        installedPackageDir: installed.packageDir, installedFromPackage: true
      };
    } catch (err) {
      return {
        agentId, success: false, previousVersion, newVersion: 'unknown',
        error: `Unexpected error updating plugin ${agentId}: ${err instanceof Error ? err.message : String(err)}`
      };
    } finally {
      UpdateLock.releaseLock(projectRoot);
    }
  }

  public async updateAllPlugins(
    projectRoot: string,
    adapters: Array<{ agentId: SupportedAgentId; adapter: any; verified: boolean }>
  ): Promise<PluginUpdateResult[]> {
    const results: PluginUpdateResult[] = [];
    for (const item of adapters) {
      results.push(await this.updatePlugin(projectRoot, item.agentId, item.adapter));
    }
    return results;
  }

  public async stageCoreUpdate(projectRoot: string, targetVersion?: string): Promise<CoreUpdateResult> {
    try {
      const check = await this.checkCoreUpdate();
      const version = targetVersion || check.latestVersion;
      if (!check.downloadUrl) {
        return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version, error: 'Release does not expose a downloadable artifact.' };
      }
      if (!check.sha256) {
        return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version, error: 'Release does not publish a SHA-256 checksum for the core artifact. Refusing unverified update.' };
      }
      this.assertSecureUrl(check.downloadUrl);
      const raw = await this.httpFetcher(check.downloadUrl);
      const archive = typeof raw === 'string' ? Buffer.from(raw) : raw;
      if (!this.verifyPackageSha256(archive, check.sha256)) {
        return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version, error: 'Core artifact SHA-256 verification failed.' };
      }
      const stagingRoot = path.join(projectRoot, '.projectmind', 'staging');
      fs.mkdirSync(stagingRoot, { recursive: true });
      const stagingDir = path.join(stagingRoot, `core-${version}-${Date.now()}`);
      extractTarGz(archive, stagingDir, {
        maxEntries: 4000,
        maxTotalBytes: 64 * 1024 * 1024,
        maxFileBytes: 16 * 1024 * 1024
      });
      const pkgPath = path.join(stagingDir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version, error: 'Downloaded core archive has no package.json.' };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name !== 'projectmind' || String(pkg.version) !== version) {
        return {
          success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version,
          error: `Core archive identity mismatch (name=${pkg.name}, version=${pkg.version}).`
        };
      }
      for (const required of ['scripts/build.js', 'packages/shared/src/index.ts', 'apps/cli/src/index.ts']) {
        if (!fs.existsSync(path.join(stagingDir, required))) {
          return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: version, error: `Core archive is missing required file: ${required}` };
        }
      }
      return {
        success: true,
        previousVersion: PROJECTMIND_VERSION,
        newVersion: version,
        stagedDir: stagingDir,
        artifactSha256: check.sha256
      };
    } catch (err) {
      return {
        success: false,
        previousVersion: PROJECTMIND_VERSION,
        newVersion: targetVersion || PROJECTMIND_VERSION,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Applies a previously staged core update to a non-git installation.
   * Git checkouts are refused by default because `git pull` is the safe path.
   */
  public applyCoreUpdate(
    installRoot: string,
    stagedDir: string,
    options?: { force?: boolean }
  ): CoreUpdateResult {
    const resolvedInstall = path.resolve(installRoot);
    const resolvedStage = path.resolve(stagedDir);
    try {
      if (!fs.existsSync(resolvedStage) || !fs.statSync(resolvedStage).isDirectory()) {
        return { success: false, previousVersion: PROJECTMIND_VERSION, newVersion: PROJECTMIND_VERSION, error: 'Staged update directory does not exist.' };
      }
      if (fs.existsSync(path.join(resolvedInstall, '.git')) && !options?.force) {
        return {
          success: false, previousVersion: PROJECTMIND_VERSION, newVersion: PROJECTMIND_VERSION,
          error: 'Refusing to overwrite a git checkout in place. Run `git pull` (recommended) or pass force: true for non-git installs.'
        };
      }
      const backupDir = path.join(resolvedInstall, '.projectmind', 'backups', `core-apply-${Date.now()}`);
      fs.mkdirSync(backupDir, { recursive: true });

      let copied = 0;
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = path.relative(resolvedStage, path.join(dir, entry.name));
          if (rel.startsWith('node_modules') || rel.startsWith('.git') || rel.startsWith('.projectmind')) continue;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name));
          } else if (entry.isFile()) {
            const target = path.join(resolvedInstall, rel);
            if (fs.existsSync(target)) {
              const backupTarget = path.join(backupDir, rel);
              fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
              fs.copyFileSync(target, backupTarget);
            }
            atomicWriteFileSync(target, fs.readFileSync(path.join(dir, entry.name)));
            copied++;
          }
        }
      };
      walk(resolvedStage);
      return {
        success: true,
        previousVersion: PROJECTMIND_VERSION,
        newVersion: PROJECTMIND_VERSION,
        backupPath: backupDir
      };
    } catch (err) {
      return {
        success: false, previousVersion: PROJECTMIND_VERSION, newVersion: PROJECTMIND_VERSION,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
