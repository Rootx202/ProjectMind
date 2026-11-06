import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  UpdateManager, UpdateLock, UnifiedUpdateManifest, GitHubReleasePayload
} from '@projectmind/plugin-sdk';
import { SetupManager } from '@projectmind/setup';
import { runCli, runCliAsync } from '@projectmind/cli';
import { PROJECTMIND_VERSION } from '@projectmind/shared';

function createMockHttpFetcher(options?: {
  latestVersion?: string;
  failDownloads?: boolean;
  tamperSha?: boolean;
  minEngineVersion?: string;
  networkError?: boolean;
}) {
  const version = options?.latestVersion || '1.1.0';
  const minEngine = options?.minEngineVersion || '1.0.0';

  return async (url: string): Promise<string | Buffer> => {
    if (options?.networkError) {
      throw new Error('ENOTFOUND api.github.com');
    }

    if (url.includes('/releases/latest')) {
      const payload: GitHubReleasePayload = {
        tag_name: `v${version}`,
        name: `ProjectMind v${version}`,
        body: `## Changes in v${version}\n- Added high-speed incremental updates\n- Enhanced MCP latency`,
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
      const sampleBuffer = Buffer.from('mock plugin content');
      const realSha = crypto.createHash('sha256').update(sampleBuffer).digest('hex');
      const shaToUse = options?.tamperSha ? 'bad_sha_00000000000000000000000000000000000000000000000000000000' : realSha;

      const manifest: UnifiedUpdateManifest = {
        engineVersion: version,
        publishedAt: '2026-11-06T18:00:00Z',
        changelog: `v${version} release notes`,
        plugins: {
          antigravity: { id: 'antigravity', name: 'Google Antigravity', version, description: '', downloadUrl: 'https://mock/antigravity.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          'claude-code': { id: 'claude-code', name: 'Anthropic Claude Code', version, description: '', downloadUrl: 'https://mock/claude-code.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          codex: { id: 'codex', name: 'OpenAI Codex', version, description: '', downloadUrl: 'https://mock/codex.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          cursor: { id: 'cursor', name: 'Cursor', version, description: '', downloadUrl: 'https://mock/cursor.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          'deepseek-harness': { id: 'deepseek-harness', name: 'DeepSeek Harness', version, description: '', downloadUrl: 'https://mock/deepseek-harness.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          'gemini-cli': { id: 'gemini-cli', name: 'Google Gemini CLI', version, description: '', downloadUrl: 'https://mock/gemini-cli.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          'github-copilot': { id: 'github-copilot', name: 'GitHub Copilot', version, description: '', downloadUrl: 'https://mock/github-copilot.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          'hermes-agent': { id: 'hermes-agent', name: 'Hermes Agent', version, description: '', downloadUrl: 'https://mock/hermes-agent.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] },
          opencode: { id: 'opencode', name: 'OpenCode', version, description: '', downloadUrl: 'https://mock/opencode.tar.gz', sha256: shaToUse, minEngineVersion: minEngine, supportedPlatforms: ['linux', 'windows', 'darwin'] }
        },
        checksums: {}
      };
      return JSON.stringify(manifest);
    }

    if (url.endsWith('SHA256SUMS')) {
      return '';
    }

    if (url.includes('.tar.gz') || url.includes('.zip')) {
      if (options?.failDownloads) {
        throw new Error('HTTP 404: Not Found');
      }
      return Buffer.from('mock plugin content');
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

  const tmpBase = path.join(os.tmpdir(), `projectmind-updater-test-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  // 1. SemVer comparison
  await check('1. SemVer comparison logic', () => {
    if (UpdateManager.compareSemVer('1.0.0', '1.0.1') >= 0) throw new Error('1.0.0 should be < 1.0.1');
    if (UpdateManager.compareSemVer('1.1.0', '1.0.9') <= 0) throw new Error('1.1.0 should be > 1.0.9');
    if (UpdateManager.compareSemVer('1.0.0', '1.0.0') !== 0) throw new Error('1.0.0 should equal 1.0.0');
    if (UpdateManager.compareSemVer('v2.0.0', '1.9.9') <= 0) throw new Error('v2.0.0 should be > 1.9.9');
  });

  // 2. Core update check (new version available)
  await check('2. Core update check detects new version on GitHub', async () => {
    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ latestVersion: '1.2.0' })
    });
    const checkRes = await updater.checkCoreUpdate();
    if (!checkRes.isOutdated) throw new Error('Expected isOutdated to be true');
    if (checkRes.latestVersion !== '1.2.0') throw new Error(`Expected 1.2.0, got ${checkRes.latestVersion}`);
    if (!checkRes.compatible) throw new Error('Expected compatible to be true');
    if (!checkRes.releaseNotes.includes('Changes in v1.2.0')) throw new Error('Expected changelog to be populated');
  });

  // 3. Core update check (already up to date)
  await check('3. Core update check when already up to date', async () => {
    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ latestVersion: PROJECTMIND_VERSION })
    });
    const checkRes = await updater.checkCoreUpdate();
    if (checkRes.isOutdated) throw new Error('Expected isOutdated to be false');
    if (checkRes.currentVersion !== checkRes.latestVersion) throw new Error('Versions should match');
  });

  // 4. Single plugin update check & outdated listing
  await check('4. Single plugin update check and outdated detection', async () => {
    const testDir = path.join(tmpBase, 'outdated-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    setup.installAdapter(testDir, 'claude-code');

    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ latestVersion: '1.1.0' })
    });
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
    if (report.outdatedCount < 1) throw new Error('outdatedCount should be >= 1');
  });

  // 5. Update all 9 plugins
  await check('5. Update all 9 plugins with manifest verification', async () => {
    const testDir = path.join(tmpBase, 'update-all-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ latestVersion: '1.1.0' })
    });

    const adapters = setup.getAllAdapters().map((a) => ({
      agentId: a.agentId,
      adapter: a,
      verified: true
    }));

    const results = await updater.updateAllPlugins(testDir, adapters);
    if (results.length !== 9) throw new Error(`Expected 9 results, got ${results.length}`);
    for (const r of results) {
      if (!r.success) throw new Error(`Plugin update failed for ${r.agentId}: ${r.error}`);
      if (r.newVersion !== '1.1.0') throw new Error(`Expected newVersion 1.1.0, got ${r.newVersion}`);
      if (!r.backupPath || !fs.existsSync(r.backupPath)) throw new Error(`Missing backup for ${r.agentId}`);
    }
  });

  // 6. Download failure handling
  await check('6. Download failure handling (HTTP error)', async () => {
    const testDir = path.join(tmpBase, 'download-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('cursor');

    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ failDownloads: true })
    });

    const res = await updater.updatePlugin(testDir, 'cursor', adapter);
    if (res.success) throw new Error('Expected update to fail due to download error');
    if (!res.error || !res.error.includes('Download failed')) {
      throw new Error(`Expected error to mention Download failed, got: ${res.error}`);
    }
  });

  // 7. SHA-256 verification and checksum mismatch handling
  await check('7. SHA-256 integrity verification detects tampered package', async () => {
    const testDir = path.join(tmpBase, 'sha-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('opencode');

    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ tamperSha: true })
    });

    const res = await updater.updatePlugin(testDir, 'opencode', adapter);
    if (res.success) throw new Error('Expected update to fail due to SHA-256 mismatch');
    if (!res.error || !res.error.includes('SHA-256 verification failed')) {
      throw new Error(`Expected SHA-256 failure message, got: ${res.error}`);
    }
  });

  // 8. Incompatible engine version prevention
  await check('8. Incompatible engine version is blocked from installation', async () => {
    const testDir = path.join(tmpBase, 'compat-fail-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();
    const adapter = setup.getAdapter('antigravity');

    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ minEngineVersion: '9.0.0' })
    });

    const res = await updater.updatePlugin(testDir, 'antigravity', adapter);
    if (res.success) throw new Error('Expected update to be blocked due to engine incompatibility');
    if (!res.error || !res.error.includes('requires ProjectMind engine >=')) {
      throw new Error(`Expected engine requirement error, got: ${res.error}`);
    }
  });

  // 9. Preservation of user settings during plugin update
  await check('9. User settings and custom config are preserved during plugin update', async () => {
    const testDir = path.join(tmpBase, 'preserve-config-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();

    // Install claude-code first and customize .claude/settings.json
    setup.installAdapter(testDir, 'claude-code');
    const settingsPath = path.join(testDir, '.claude', 'settings.json');
    const customConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    customConfig.userCustomTheme = 'cyberpunk';
    customConfig.userCustomKey = 'secret-123';
    fs.writeFileSync(settingsPath, JSON.stringify(customConfig, null, 2), 'utf8');

    // Run update
    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ latestVersion: '1.1.0' })
    });
    const res = await updater.updatePlugin(testDir, 'claude-code', setup.getAdapter('claude-code'));
    if (!res.success) throw new Error(`Update failed: ${res.error}`);

    // Verify custom properties survived the update
    const updatedConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (updatedConfig.userCustomTheme !== 'cyberpunk') throw new Error('userCustomTheme was overwritten!');
    if (updatedConfig.userCustomKey !== 'secret-123') throw new Error('userCustomKey was overwritten!');
  });

  // 10. Offline / network error handling
  await check('10. Offline and network errors fail open gracefully', async () => {
    const testDir = path.join(tmpBase, 'offline-test');
    fs.mkdirSync(testDir, { recursive: true });
    const setup = new SetupManager();

    const updater = new UpdateManager({
      httpFetcher: createMockHttpFetcher({ networkError: true })
    });

    const checkRes = await updater.checkCoreUpdate();
    if (checkRes.isOutdated) throw new Error('Should not report outdated when offline');
    if (!checkRes.releaseNotes.includes('Offline or failed')) {
      throw new Error('Expected offline notification in release notes');
    }

    const report = await updater.checkOutdatedPlugins(testDir, []);
    if (report.outdatedCount !== 0) throw new Error('outdatedCount should be 0 when offline');
  });

  // 11. Mutex lockfile prevents concurrent updates
  await check('11. Mutex lockfile prevents simultaneous updates', () => {
    const testDir = path.join(tmpBase, 'lock-test');
    fs.mkdirSync(testDir, { recursive: true });

    const lock1 = UpdateLock.acquireLock(testDir, 'test-op-1');
    if (!lock1) throw new Error('Failed to acquire initial lock');

    const lock2 = UpdateLock.acquireLock(testDir, 'test-op-2');
    if (lock2) throw new Error('Should not acquire lock when already held!');

    UpdateLock.releaseLock(testDir);
    const lock3 = UpdateLock.acquireLock(testDir, 'test-op-3');
    if (!lock3) throw new Error('Should acquire lock after previous was released');
    UpdateLock.releaseLock(testDir);
  });

  // 12. CLI runCli commands for update and upgrade
  await check('12. CLI commands (update check, upgrade check, plugin outdated)', async () => {
    const testDir = path.join(tmpBase, 'cli-test');
    fs.mkdirSync(testDir, { recursive: true });

    // 12a. update check (json)
    const updateCheck = await runCliAsync(['node', 'projectmind', 'update', 'check', '--json', '--project-root', testDir]);
    if (updateCheck.exitCode !== 0) throw new Error(`update check failed: ${updateCheck.output}`);
    const checkJson = JSON.parse(updateCheck.output);
    if (!checkJson.currentVersion) throw new Error('Missing currentVersion in update check output');

    // 12b. upgrade check (alias)
    const upgradeCheck = await runCliAsync(['node', 'projectmind', 'upgrade', 'check', '--project-root', testDir]);
    if (upgradeCheck.exitCode !== 0) throw new Error(`upgrade check failed: ${upgradeCheck.output}`);

    // 12c. plugin outdated (json)
    const outdated = await runCliAsync(['node', 'projectmind', 'plugin', 'outdated', '--json', '--project-root', testDir]);
    if (outdated.exitCode !== 0) throw new Error(`plugin outdated failed: ${outdated.output}`);
    const outJson = JSON.parse(outdated.output);
    if (!Array.isArray(outJson.plugins)) throw new Error('Expected plugins array in outdated report');
  });

  // Cleanup tmpBase
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (_) {}

  return { passed, failed, details };
}
