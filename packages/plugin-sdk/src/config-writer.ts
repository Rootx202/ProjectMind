import * as fs from 'node:fs';
import * as path from 'node:path';

export class ConfigWriter {
  /**
   * Writes a JSON file atomically using a temporary file and atomic rename.
   */
  public static writeJsonAtomic(filePath: string, data: Record<string, any>): void {
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    const content = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      const fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, content, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      fs.renameSync(tmpPath, resolvedPath);

      // Validate the written file immediately
      const verified = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      if (typeof verified !== 'object' || verified === null) {
        throw new Error(`Verification failed: parsed content is not an object.`);
      }
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }
  }

  /**
   * Reads a JSON file safely, applies mutations, preserves all unrelated entries,
   * and writes the updated document atomically.
   */
  public static updateJsonPreservingUnrelated(
    filePath: string,
    updater: (existing: Record<string, any>) => Record<string, any>
  ): Record<string, any> {
    const resolvedPath = path.resolve(filePath);
    let existing: Record<string, any> = {};

    if (fs.existsSync(resolvedPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      } catch (err) {
        process.stderr.write(`[ProjectMind Config Warning] Existing JSON at ${resolvedPath} was invalid or corrupt; resetting: ${err}\n`);
        existing = {};
      }
    }

    const updated = updater(existing);
    this.writeJsonAtomic(resolvedPath, updated);
    return updated;
  }

  /**
   * Atomically upserts an identifiable managed section in a text file
   * without destroying surrounding user configuration.
   */
  public static upsertManagedSectionAtomic(
    filePath: string,
    startMarker: string,
    endMarker: string,
    contentBlock: string
  ): void {
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    let original = '';
    if (fs.existsSync(resolvedPath)) {
      original = fs.readFileSync(resolvedPath, 'utf8');
    }

    const startIdx = original.indexOf(startMarker);
    const endIdx = original.indexOf(endMarker);

    let updated: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      updated = original.slice(0, startIdx) + contentBlock + original.slice(endIdx + endMarker.length);
    } else {
      const sep = original.length === 0 ? '' : (original.endsWith('\n') ? '\n' : '\n\n');
      updated = original + sep + contentBlock + '\n';
    }

    this.writeTextAtomic(resolvedPath, updated);
  }

  /**
   * Atomically removes an identifiable managed section in a text file.
   */
  public static removeManagedSectionAtomic(
    filePath: string,
    startMarker: string,
    endMarker: string
  ): boolean {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) return false;

    const original = fs.readFileSync(resolvedPath, 'utf8');
    const startIdx = original.indexOf(startMarker);
    const endIdx = original.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) return false;

    const cleaned = (original.slice(0, startIdx) + original.slice(endIdx + endMarker.length))
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned) {
      fs.rmSync(resolvedPath, { force: true });
    } else {
      this.writeTextAtomic(resolvedPath, cleaned + '\n');
    }

    return true;
  }

  public static writeTextAtomic(filePath: string, text: string): void {
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    const tmpPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, text, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      fs.renameSync(tmpPath, resolvedPath);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }
  }

  /**
   * Backs up a target configuration file before modification.
   */
  public static backupFile(projectRoot: string, targetFilePath: string, customBackupDir?: string): string | null {
    const resolvedTarget = path.resolve(targetFilePath);
    if (!fs.existsSync(resolvedTarget)) return null;

    const resolvedRoot = path.resolve(projectRoot);
    const backupRoot = customBackupDir ? path.resolve(customBackupDir) : path.join(resolvedRoot, '.projectmind', 'config-backups');
    fs.mkdirSync(backupRoot, { recursive: true });

    const relName = path.relative(resolvedRoot, resolvedTarget).replace(/[\\/]/g, '__');
    const backupPath = path.join(backupRoot, `${relName}.${Date.now()}.bak`);
    fs.copyFileSync(resolvedTarget, backupPath);
    return backupPath;
  }

  /**
   * Restores the most recent backup for a target file.
   */
  public static restoreLatestBackup(projectRoot: string, targetFilePath: string, customBackupDir?: string): string | null {
    const resolvedTarget = path.resolve(targetFilePath);
    const resolvedRoot = path.resolve(projectRoot);
    const backupRoot = customBackupDir ? path.resolve(customBackupDir) : path.join(resolvedRoot, '.projectmind', 'config-backups');
    if (!fs.existsSync(backupRoot)) return null;

    const relPrefix = path.relative(resolvedRoot, resolvedTarget).replace(/[\\/]/g, '__');
    const entries = fs.readdirSync(backupRoot)
      .filter((name) => name.startsWith(relPrefix) && name.endsWith('.bak'))
      .sort()
      .reverse();

    if (entries.length === 0) return null;

    const latestBackup = path.join(backupRoot, entries[0]);
    fs.copyFileSync(latestBackup, resolvedTarget);
    return latestBackup;
  }
}

