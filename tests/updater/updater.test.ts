import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  UpdateManager, UpdateLock, UnifiedUpdateManifest, GitHubReleasePayload,
  createTarGz, extractTarGz, ArchiveSecurityError
} from '@projectmind/plugin-sdk';
import { SetupManager } from '@projectmind/setup';
import { runCliAsync } from '@projectmind/cli';
import { PROJECTMIND_VERSION } from '@projectmind/shared';

const AGENT_IDS = [
  'antigravity', 'claude-code', 'codex', 'cursor', 'deepseek-harness',
  'gemini-cli', 'github-copilot', 'hermes-agent', 'opencode'
] as const;

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

interface Bundle {
  buffer: Buffer;
  sha256: string;
}

/** Builds a raw tar entry without path validation, to exercise the extractor. */
function rawTarEntry(entryPath: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(entryPath.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024, 0)]);
}

function buildBundle(agentId: string, version: string, options?: { extraUndeclared?: boolean }): Bundle {
  const manifest: any = {
    id: agentId,
    name: `ProjectMind ${agentId}`,
    version,
    minEngineVersion: '1.0.0',
    assets: { instructions: 'assets/instructions.md', skill: 'assets/SKILL.md' },
    files: []
  };
  const entries = [
    { path: 'manifest.json', content: '' },
    { path: 'README.md', content: `# ProjectMind ${agentId} v${version}\nVerified release bundle.\n` },
    {
      path: 'assets/instructions.md',
      content: `<!-- PROJECTMIND:START -->\n## ProjectMind ${agentId} v${version}\nUse ProjectMind memory before scanning files.\n<!-- PROJECTMIND:END -->\n`
    },
    {
      path: 'assets/SKILL.md',
      content: `---\nname: projectmind\n---\n# ProjectMind skill ${agentId} v${version}\n`
    }
  ];
  if (options?.extraUndeclared) {
    entries.push({ path: 'assets/payload.bin', content: 'undeclared' });
  }
  manifest.files = entries
    .filter((e) => e.path !== 'manifest.json' && !(options?.extraUndeclared && e.path === 'assets/payload.bin'))
    .map((e) => ({ path: e.path, sha256: sha256(e.content) }));
  entries[0].content = JSON.stringify(manifest, null, 2);
  const buffer = createTarGz(entries);
  return { buffer, sha256: sha256(buffer) };
}

function createMockHttpFetcher(options?: {
  latestVersion?: string;
  failDownloads?: boolean;
  tamperSha?: boolean;
  missingSha?: boolean;
  minEngineVersion?: string;
  networkError?: boolean;
  undeclaredFile?: boolean;
}) {
  const version = options?.latestVersion || '1.2.0';
  const minEngine = options?.minEngineVersion || '1.0.0';
  const bundles = new Map<string, Bundle>();
  for (const id of AGENT_IDS) bundles.set(id, buildBundle(id, version, { extraUndeclared: options?.undeclaredFile }));

  return async (url: string): Promise<string | Buffer> => {
    if (options?.networkError) throw new Error('ENOTFOUND api.github.com');

    if (url.includes('/releases/latest')) {
      const payload: GitHubReleasePayload = {
        tag_name: `v${version}`,
        name: `ProjectMind v${version}`,
        body: `## Changes in v${version}\n- Hardened update verification\n- Snapshot-bound retrieval cache`,
        published_at: '2026-11-06T18:00:00Z',
        draft: false,
        prerelease: false,
        assets: [
          {
            id: 101,
            name: 'index.json',
            size: 2048,
            browser_download_url: `https://github.com/Rootx202/ProjectMind/releases/download/v${version}/index.json`,
            content_type: 'application/json'
          },
          {
            id: 102,
            name: 'SHA256SUMS',
            size: 512,
            browser_download_url: `https://github.com/Rootx202/ProjectMind/releases/download/v${version}/SHA256SUMS`,
            content_type: 'text/plain'
          }
        ]
      };
      return JSON.stringify(payload);
    }

    if (url.endsWith('index.json')) {
      const plugins: Record<string, any> = {};
      for (const id of AGENT_IDS) {
        const bundle = bundles.get(id)!;
        plugins[id] = {
          id,
          name: id,
          version,
          description: `Bundle ${id}`,
          downloadUrl: `https://github.com/Rootx202/ProjectMind/releases/download/v${version}/${id}-${version}.tar.gz`,
          sha256: options?.missingSha ? '' : (options?.tamperSha ? 'bad_sha_00000000000000000000000000000000000000000000000000000000' : bundle.sha256),
          minEngineVersion: minEngine,
          supportedPlatforms: ['linux', 'windows', 'darwin']
        };
      }
      const manifest: UnifiedUpdateManifest = {
        engineVersion: version,
        publishedAt: '2026-11-06T18:00:00Z',
        changelog: `v${version} release notes`,
        plugins,
        checksums: {}
      };
      return JSON.stringify(manifest);
    }

    if (url.endsWith('SHA256SUMS')) {
      if (options?.missingSha) return '';
      return Array.from(bundles.entries())
        .map(([id, bundle]) => `${bundle.sha256}  ${id}-${version}.tar.gz`)
        .join('\n') + '\n';
    }

    if (url.endsWith('.tar.gz')) {
      if (options?.failDownloads) throw new Error('HTTP 404: Not Found');
      const match = url.match(/\/([a-z0-9-]+)-\d+\.\d+\.\d+\.tar\.gz$/);
      const bundle = match ? bundles.get(match[1]) : undefined;
      if (!bundle) throw new Error(`No mock bundle for ${url}`);
      return bundle.buffer;
    }

    return '';
  };
}

export async function runUpdaterTests(): Promise<{ passed: number; failed: number; details: string[] }> {
  let passed = 0;
  let failed = 0;
  const details: string[] = [];

  async function check(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      passed++;
      details.push(`PASS [Updater] ${name}`);
    } catch (err: any) {
      failed++;
      details.push(`FAIL [Updater] ${name}: ${err?.message || err}`);
    }
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'projectmind-updater-test-'));

  await check('1. SemVer comparison logic', () => {
    if (UpdateManager.compareSemVer('1.0.0', '1.0.1') >= 0) throw new Error('1.0.0 should be < 1.0.1');
    if (UpdateManager.compareSemVer('1.1.0', '1.0.9') <= 0) throw new Error('1.1.0 should be > 1.0.9');
    if (UpdateManager.compareSemVer('1.0.0', '1.0.0') !== 0) throw new Error('1.0.0 should equal 1.0.0');
    if (UpdateManager.compareSemVer('v2.0.0', '1.9.9') <= 0) throw new Error('v2.0.0 should be > 1.9.9');
  });

  await check('2. Core update check detects new version on GitHub', async () => {
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ latestVersion: '1.2.0' }) });
    const checkRes = await updater.checkCoreUpdate();
    if (!checkRes.isOutdated) throw new Error('Expected isOutdated to be true');
    if (checkRes.latestVersion !== '1.2.0') throw new Error(`Expected 1.2.0, got ${checkRes.latestVersion}`);
    if (!checkRes.compatible) throw new Error('Expected compatible to be true');
    if (!checkRes.releaseNotes.includes('Changes in v1.2.0')) throw new Error('Expected changelog to be populated');
  });

  await check('3. Core update check when already up to date', async () => {
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ latestVersion: PROJECTMIND_VERSION }) });
    const checkRes = await updater.checkCoreUpdate();
    if (checkRes.isOutdated) throw new Error('Expected isOutdated to be false');
    if (checkRes.currentVersion !== checkRes.latestVersion) throw new Error('Versions should match');
  });

  await check('4. Single plugin update check and outdated detection', async () => {
    const testDir = path.join(tmpBase, 'outdated-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    setup.installAdapter(testDir, 'claude-code');

    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ latestVersion: '1.2.0' }) });
    const adapters = setup.getAllAdapters().map((a) => ({
      agentId: a.agentId,
      displayName: a.displayName,
      verified: a.verify(testDir).verified
    }));

    const report = await updater.checkOutdatedPlugins(testDir, adapters);
    const claudeEntry = report.plugins.find((p) => p.agentId === 'claude-code');
    if (!claudeEntry) throw new Error('Missing claude-code in report');
    if (!claudeEntry.isInstalled) throw new Error('claude-code should be installed');
    if (!claudeEntry.isOutdated) throw new Error('claude-code should be outdated');
    if (!claudeEntry.checksumAvailable) throw new Error('Expected checksum to be published');
    if (report.outdatedCount < 1) throw new Error('outdatedCount should be >= 1');
  });

  await check('5. Update all 9 plugins installs verified package artifacts', async () => {
    const testDir = path.join(tmpBase, 'update-all-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ latestVersion: '1.2.0' }) });

    const adapters = setup.getAllAdapters().map((a) => ({ agentId: a.agentId, adapter: a, verified: true }));
    const results = await updater.updateAllPlugins(testDir, adapters);
    if (results.length !== 9) throw new Error(`Expected 9 results, got ${results.length}`);
    for (const r of results) {
      if (!r.success) throw new Error(`Plugin update failed for ${r.agentId}: ${r.error}`);
      if (r.newVersion !== '1.2.0') throw new Error(`Expected newVersion 1.2.0, got ${r.newVersion}`);
      if (!r.backupPath || !fs.existsSync(r.backupPath)) throw new Error(`Missing backup for ${r.agentId}`);
      if (!r.installedFromPackage) throw new Error(`Plugin ${r.agentId} was not installed from the verified package`);
      if (!r.artifactSha256 || !/^[a-f0-9]{64}$/.test(r.artifactSha256)) throw new Error('Missing artifact sha256');
      if (!fs.existsSync(r.installedPackageDir || '')) throw new Error('Installed package dir missing');
      const state = JSON.parse(fs.readFileSync(path.join(testDir, '.projectmind', 'plugins', r.agentId, 'state.json'), 'utf8'));
      if (state.currentVersion !== '1.2.0') throw new Error('Package state version mismatch');
    }

    // The downloaded assets must actually reach the agent integration files.
    const codexSkill = fs.readFileSync(path.join(testDir, '.agents', 'skills', 'projectmind', 'SKILL.md'), 'utf8');
    if (!codexSkill.includes('v1.2.0')) throw new Error('Downloaded package SKILL.md was not applied for codex');
    const claudeMd = fs.readFileSync(path.join(testDir, 'CLAUDE.md'), 'utf8');
    if (!claudeMd.includes('v1.2.0')) throw new Error('Downloaded package instructions were not applied for claude-code');
  });

  await check('6. Download failure handling (HTTP error)', async () => {
    const testDir = path.join(tmpBase, 'download-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('cursor');
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ failDownloads: true }) });

    const res = await updater.updatePlugin(testDir, 'cursor', adapter);
    if (res.success) throw new Error('Expected update to fail due to download error');
    if (!res.error || !res.error.includes('Download failed')) throw new Error(`Expected Download failed, got: ${res.error}`);
  });

  await check('7. SHA-256 verification detects tampered package', async () => {
    const testDir = path.join(tmpBase, 'sha-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('opencode');
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ tamperSha: true }) });

    const res = await updater.updatePlugin(testDir, 'opencode', adapter);
    if (res.success) throw new Error('Expected update to fail due to SHA-256 mismatch');
    if (!res.error || !res.error.includes('SHA-256 verification failed')) throw new Error(`Expected SHA-256 failure, got: ${res.error}`);
  });

  await check('8. Incompatible engine version is blocked from installation', async () => {
    const testDir = path.join(tmpBase, 'compat-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('antigravity');
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ minEngineVersion: '9.0.0' }) });

    const res = await updater.updatePlugin(testDir, 'antigravity', adapter);
    if (res.success) throw new Error('Expected update to be blocked due to engine incompatibility');
    if (!res.error || !/requires .*engine >=/.test(res.error)) throw new Error(`Expected engine requirement error, got: ${res.error}`);
  });

  await check('9. User settings and custom config are preserved during plugin update', async () => {
    const testDir = path.join(tmpBase, 'preserve-config-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    setup.installAdapter(testDir, 'claude-code');
    const settingsPath = path.join(testDir, '.claude', 'settings.json');
    const customConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    customConfig.userCustomTheme = 'cyberpunk';
    customConfig.userCustomKey = 'secret-123';
    fs.writeFileSync(settingsPath, JSON.stringify(customConfig, null, 2), 'utf8');

    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ latestVersion: '1.2.0' }) });
    const res = await updater.updatePlugin(testDir, 'claude-code', setup.getAdapter('claude-code'));
    if (!res.success) throw new Error(`Update failed: ${res.error}`);

    const updatedConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (updatedConfig.userCustomTheme !== 'cyberpunk') throw new Error('userCustomTheme was overwritten!');
    if (updatedConfig.userCustomKey !== 'secret-123') throw new Error('userCustomKey was overwritten!');
  });

  await check('10. Offline and network errors fail open gracefully', async () => {
    const testDir = path.join(tmpBase, 'offline-test');
    fs.mkdirSync(testDir, { recursive: true });
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ networkError: true }) });

    const checkRes = await updater.checkCoreUpdate();
    if (checkRes.isOutdated) throw new Error('Should not report outdated when offline');
    if (!checkRes.releaseNotes.includes('Offline or failed')) throw new Error('Expected offline notification');

    const report = await updater.checkOutdatedPlugins(testDir, []);
    if (report.outdatedCount !== 0) throw new Error('outdatedCount should be 0 when offline');
  });

  await check('11. Mutex lockfile prevents simultaneous updates', () => {
    const testDir = path.join(tmpBase, 'lock-test');
    fs.mkdirSync(testDir, { recursive: true });
    if (!UpdateLock.acquireLock(testDir, 'test-op-1')) throw new Error('Failed to acquire initial lock');
    if (UpdateLock.acquireLock(testDir, 'test-op-2')) throw new Error('Should not acquire lock when already held!');
    UpdateLock.releaseLock(testDir);
    if (!UpdateLock.acquireLock(testDir, 'test-op-3')) throw new Error('Should acquire lock after release');
    UpdateLock.releaseLock(testDir);
  });

  await check('12. CLI commands (update check, upgrade check, plugin outdated)', async () => {
    const testDir = path.join(tmpBase, 'cli-test');
    fs.mkdirSync(testDir, { recursive: true });
    const updateCheck = await runCliAsync(['node', 'projectmind', 'update', 'check', '--json', '--project-root', testDir]);
    if (updateCheck.exitCode !== 0) throw new Error(`update check failed: ${updateCheck.output}`);
    const checkJson = JSON.parse(updateCheck.output);
    if (!checkJson.currentVersion) throw new Error('Missing currentVersion in update check output');

    const upgradeCheck = await runCliAsync(['node', 'projectmind', 'upgrade', 'check', '--project-root', testDir]);
    if (upgradeCheck.exitCode !== 0) throw new Error(`upgrade check failed: ${upgradeCheck.output}`);

    const outdated = await runCliAsync(['node', 'projectmind', 'plugin', 'outdated', '--json', '--project-root', testDir]);
    if (outdated.exitCode !== 0) throw new Error(`plugin outdated failed: ${outdated.output}`);
    const outJson = JSON.parse(outdated.output);
    if (!Array.isArray(outJson.plugins)) throw new Error('Expected plugins array in outdated report');
  });

  await check('13. Missing checksum is rejected (no unsigned updates)', async () => {
    const testDir = path.join(tmpBase, 'missing-sha-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const updater = new UpdateManager({ httpFetcher: createMockHttpFetcher({ missingSha: true }) });

    const res = await updater.updatePlugin(testDir, 'codex', setup.getAdapter('codex'));
    if (res.success) throw new Error('Expected missing checksum to be rejected');
    if (!res.error || !res.error.includes('Missing SHA-256')) throw new Error(`Expected missing SHA-256 error, got: ${res.error}`);
  });

  await check('14. Archive path traversal, symlinks, and undeclared files are rejected', async () => {
    if (process.platform === 'win32') return;
    const dest = path.join(tmpBase, 'extract-test');
    const evil = require('zlib').gzipSync(rawTarEntry('../escaped.txt', Buffer.from('x')));
    let traversalRejected = false;
    try { extractTarGz(evil, dest); } catch (err) { traversalRejected = err instanceof ArchiveSecurityError; }
    if (!traversalRejected) throw new Error('Path traversal archive was not rejected');

    // A tar header with typeflag '2' (symlink) must be rejected.
    const symlinkTar = Buffer.alloc(512 * 3, 0);
    symlinkTar.write('link', 0, 'utf8');
    symlinkTar[156] = '2'.charCodeAt(0);
    const gz = require('zlib').gzipSync(symlinkTar);
    let symlinkRejected = false;
    try { extractTarGz(gz, dest); } catch (err) { symlinkRejected = err instanceof ArchiveSecurityError; }
    if (!symlinkRejected) throw new Error('Symlink archive was not rejected');

    const testDir = path.join(tmpBase, 'undeclared-test');
    fs.mkdirSync(testDir, { recursive: true });
    const bundle = buildBundle('codex', '1.2.0', { extraUndeclared: true });
    const updater = new UpdateManager({
      httpFetcher: async (url: string) => {
        if (url.includes('/releases/latest')) {
          return JSON.stringify({
            tag_name: 'v1.2.0', name: 'ProjectMind v1.2.0', body: '', published_at: '2026-11-06T18:00:00Z',
            draft: false, prerelease: false,
            assets: [
              { id: 1, name: 'index.json', size: 100, browser_download_url: 'https://github.com/Rootx202/ProjectMind/releases/download/v1.2.0/index.json', content_type: 'application/json' },
              { id: 2, name: 'SHA256SUMS', size: 100, browser_download_url: 'https://github.com/Rootx202/ProjectMind/releases/download/v1.2.0/SHA256SUMS', content_type: 'text/plain' }
            ]
          });
        }
        if (url.endsWith('index.json')) {
          return JSON.stringify({
            engineVersion: '1.2.0',
            plugins: {
              codex: {
                id: 'codex', name: 'Codex', version: '1.2.0', description: '',
                downloadUrl: 'https://github.com/Rootx202/ProjectMind/releases/download/v1.2.0/codex-1.2.0.tar.gz',
                sha256: bundle.sha256, minEngineVersion: '1.0.0', supportedPlatforms: ['linux']
              }
            },
            checksums: {}
          });
        }
        if (url.endsWith('SHA256SUMS')) return '';
        return bundle.buffer;
      }
    });
    const res = await updater.updatePlugin(testDir, 'codex', new SetupManager().getAdapter('codex'));
    if (res.success) throw new Error('Undeclared archive file was not rejected');
    if (!res.error || !res.error.includes('undeclared file')) throw new Error(`Expected undeclared file error, got: ${res.error}`);
  });

  await check('15. Insecure protocol and untrusted hosts are refused', () => {
    const updater = new UpdateManager({});
    let httpRejected = false;
    try { updater.assertSecureUrl('http://github.com/x'); } catch (_) { httpRejected = true; }
    if (!httpRejected) throw new Error('HTTP URL was not rejected');
    let hostRejected = false;
    try { updater.assertSecureUrl('https://evil.example/x'); } catch (_) { hostRejected = true; }
    if (!hostRejected) throw new Error('Untrusted host was not rejected');
    updater.assertSecureUrl('https://github.com/Rootx202/ProjectMind/releases/download/v1/x.tar.gz');
  });

  await check('16. Core update stages a verified artifact and refuses git checkouts', async () => {
    const installDir = path.join(tmpBase, 'core-install');
    fs.mkdirSync(installDir, { recursive: true });
    const bundle = createTarGz([
      { path: 'package.json', content: JSON.stringify({ name: 'projectmind', version: '9.9.9' }) },
      { path: 'scripts/build.js', content: '// build' },
      { path: 'packages/shared/src/index.ts', content: '// shared' },
      { path: 'apps/cli/src/index.ts', content: '// cli' }
    ]);
    const updater = new UpdateManager({
      httpFetcher: async (url: string) => {
        if (url.includes('/releases/latest')) {
          return JSON.stringify({
            tag_name: 'v9.9.9', name: 'ProjectMind v9.9.9', body: 'notes', published_at: '2026-11-06T18:00:00Z',
            draft: false, prerelease: false,
            assets: [
              { id: 1, name: 'projectmind-full.tar.gz', size: bundle.length, browser_download_url: 'https://github.com/Rootx202/ProjectMind/releases/download/v9.9.9/projectmind-full.tar.gz', content_type: 'application/gzip' },
              { id: 2, name: 'SHA256SUMS', size: 100, browser_download_url: 'https://github.com/Rootx202/ProjectMind/releases/download/v9.9.9/SHA256SUMS', content_type: 'text/plain' }
            ]
          });
        }
        if (url.endsWith('SHA256SUMS')) return `${sha256(bundle)}  projectmind-full.tar.gz\n`;
        if (url.endsWith('.tar.gz')) return bundle;
        return '';
      }
    });

    const staged = await updater.stageCoreUpdate(installDir);
    if (!staged.success) throw new Error(`Staging failed: ${staged.error}`);
    if (!staged.stagedDir || !fs.existsSync(staged.stagedDir)) throw new Error('Missing staged dir');

    fs.mkdirSync(path.join(installDir, '.git'), { recursive: true });
    const refused = updater.applyCoreUpdate(installDir, staged.stagedDir!);
    if (refused.success) throw new Error('applyCoreUpdate should refuse a git checkout');
    fs.rmSync(path.join(installDir, '.git'), { recursive: true, force: true });

    const applied = updater.applyCoreUpdate(installDir, staged.stagedDir!);
    if (!applied.success) throw new Error(`Apply failed: ${applied.error}`);
    if (!fs.existsSync(path.join(installDir, 'package.json'))) throw new Error('Core files were not applied');
  });

  await check('17. Archive extraction enforces entry and size limits', () => {
    const dest = path.join(tmpBase, 'limits-test');
    const many = createTarGz(Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' })));
    let rejected = false;
    try { extractTarGz(many, dest, { maxEntries: 5 }); } catch (err) { rejected = err instanceof ArchiveSecurityError; }
    if (!rejected) throw new Error('Entry limit was not enforced');
  });

  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  return { passed, failed, details };
}
