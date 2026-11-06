import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

export interface TarEntry {
  path: string;
  content: Buffer;
  mode?: number;
}

export interface ExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxCompressedBytes: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 512,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxCompressedBytes: 32 * 1024 * 1024
};

export class ArchiveSecurityError extends Error {}

function readString(buffer: Buffer, start: number, length: number): string {
  let end = start;
  const max = start + length;
  while (end < max && buffer[end] !== 0) end++;
  return buffer.subarray(start, end).toString('utf8');
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const raw = readString(buffer, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveSecurityError(`Invalid tar numeric field: "${raw}"`);
  return parseInt(raw, 8);
}

function isSafeRelativePath(candidate: string): boolean {
  if (!candidate || candidate.includes('\0')) return false;
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(candidate)) return false;
  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') return false;
  return true;
}

function resolveInside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArchiveSecurityError(`Archive entry escapes destination: ${relative}`);
  }
  return resolved;
}

/**
 * Extracts a gzip-compressed tar archive with strict validation:
 *  - only regular files and directories (symlinks/hardlinks/devices rejected)
 *  - no absolute paths, `..` traversal, or Windows drive prefixes
 *  - bounded entry count, total extracted size, per-file size, compressed size
 */
export function extractTarGz(
  compressed: Buffer,
  destinationDir: string,
  limits: Partial<ExtractLimits> = {}
): { files: string[]; totalBytes: number; sha256ByPath: Record<string, string> } {
  const cfg = { ...DEFAULT_EXTRACT_LIMITS, ...limits };
  if (compressed.length > cfg.maxCompressedBytes) {
    throw new ArchiveSecurityError(`Compressed archive is too large (${compressed.length} > ${cfg.maxCompressedBytes} bytes)`);
  }
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(compressed, { maxOutputLength: cfg.maxTotalBytes + 1024 * 1024 });
  } catch (err) {
    throw new ArchiveSecurityError(`Failed to gunzip archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (tar.length > cfg.maxTotalBytes + 1024 * 1024) {
    throw new ArchiveSecurityError('Uncompressed archive exceeds the configured size limit');
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  const files: string[] = [];
  const sha256ByPath: Record<string, string> = {};
  let offset = 0;
  let totalBytes = 0;
  let entries = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    entries++;
    if (entries > cfg.maxEntries) throw new ArchiveSecurityError(`Archive has more than ${cfg.maxEntries} entries`);

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8) || 0o644;
    const fullName = prefix ? `${prefix}/${name}` : name;

    if (!isSafeRelativePath(fullName)) {
      throw new ArchiveSecurityError(`Unsafe archive entry path: "${fullName}"`);
    }
    if (size > cfg.maxFileBytes) {
      throw new ArchiveSecurityError(`Archive entry "${fullName}" is too large (${size} bytes)`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ArchiveSecurityError(`Truncated tar entry: "${fullName}"`);
    const data = tar.subarray(dataStart, dataEnd);

    if (typeFlag === '5') {
      fs.mkdirSync(resolveInside(destinationDir, fullName), { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') {
      totalBytes += size;
      if (totalBytes > cfg.maxTotalBytes) throw new ArchiveSecurityError('Archive expands beyond the configured total size limit');
      const target = resolveInside(destinationDir, fullName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { mode: mode & 0o777 });
      const rel = path.relative(destinationDir, target).replace(/\\/g, '/');
      files.push(rel);
      sha256ByPath[rel] = crypto.createHash('sha256').update(data).digest('hex');
    } else {
      throw new ArchiveSecurityError(`Unsupported tar entry type "${typeFlag}" for "${fullName}" (symlinks are not allowed)`);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return { files, totalBytes, sha256ByPath };
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0').slice(0, length - 1);
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value.slice(0, length), offset, length, 'utf8');
}

/** Creates a deterministic ustar.gz archive (used by release packaging and tests). */
export function createTarGz(entries: TarEntry[], gzipOptions: zlib.ZlibOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  // Reproducible builds: honor SOURCE_DATE_EPOCH, otherwise use a fixed epoch so
  // identical content always produces an identical archive hash.
  const sourceEpoch = Number(process.env.SOURCE_DATE_EPOCH || 0);
  const mtime = Number.isFinite(sourceEpoch) && sourceEpoch > 0 ? Math.floor(sourceEpoch) : 1700000000;
  for (const entry of entries) {
    const relative = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!isSafeRelativePath(relative)) throw new ArchiveSecurityError(`Refusing to pack unsafe path: ${entry.path}`);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const header = Buffer.alloc(512, 0);
    writeString(header, relative, 0, 100);
    writeOctal(header, entry.mode || 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, content.length, 124, 12);
    writeOctal(header, mtime, 136, 12);
    header.write('        ', 148, 8, 'ascii');
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeString(header, 'projectmind', 265, 32);
    writeString(header, 'projectmind', 297, 32);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumText = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(checksumText, 148, 8, 'ascii');
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), gzipOptions);
}
