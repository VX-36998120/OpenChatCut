import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);

export function ffmpegBinaryPath(root, target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported FFmpeg target: ${target}`);
  return join(root, 'node_modules', 'ffmpeg-static', target.startsWith('win32-') ? 'ffmpeg.exe' : 'ffmpeg');
}

export function ffprobeBinaryPath(root, target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported FFprobe target: ${target}`);
  return join(root, 'node_modules', '@ffprobe-installer', target, target.startsWith('win32-') ? 'ffprobe.exe' : 'ffprobe');
}

function binaryTarget(path) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size < 1_000_000) return null;
    const header = Buffer.alloc(4096);
    const length = readSync(fd, header, 0, header.length, 0);
    if (length < 64) return null;
    if (header.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = header.readUInt32LE(4);
      return cpu === 0x0100000c ? 'darwin-arm64' : cpu === 0x01000007 ? 'darwin-x64' : null;
    }
    if (header.toString('ascii', 0, 2) === 'MZ') {
      const pe = header.readUInt32LE(0x3c);
      return pe + 6 <= length && header.toString('ascii', pe, pe + 4) === 'PE\0\0'
        && header.readUInt16LE(pe + 4) === 0x8664 ? 'win32-x64' : null;
    }
    if (header.toString('hex', 0, 4) === '7f454c46' && header[4] === 2 && header.readUInt16LE(18) === 0x3e) {
      return 'linux-x64';
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function assertTargetFfmpeg(path, target) {
  const actual = binaryTarget(path);
  if (actual !== target) throw new Error(`FFmpeg for ${target} missing or wrong architecture: ${path} (found ${actual ?? 'none'})`);
}

export function ensureTargetFfmpeg(root, target) {
  const binary = ffmpegBinaryPath(root, target);
  if (binaryTarget(binary) === target) {
    console.log(`[prepare] FFmpeg ok: ${target}`);
    return;
  }
  const [platform, arch] = target.split('-');
  const installer = join(root, 'node_modules', 'ffmpeg-static', 'install.js');
  if (!existsSync(installer)) throw new Error(`ffmpeg-static installer missing: ${installer}`);
  // ffmpeg-static's installer skips an existing file, even when it belongs to another platform.
  rmSync(binary, { force: true });
  const env = { ...process.env, npm_config_platform: platform, npm_config_arch: arch };
  delete env.FFMPEG_BIN;
  console.log(`[prepare] installing FFmpeg for ${target}`);
  execFileSync(process.execPath, [installer], { cwd: root, env, stdio: 'inherit' });
  assertTargetFfmpeg(binary, target);
  console.log(`[prepare] FFmpeg ready: ${target}`);
}

export function assertTargetFfprobe(path, target) {
  const actual = binaryTarget(path);
  if (actual !== target) throw new Error(`FFprobe for ${target} missing or wrong architecture: ${path} (found ${actual ?? 'none'})`);
  if (!target.startsWith('win32-') && !(statSync(path).mode & 0o111)) {
    throw new Error(`FFprobe for ${target} is not executable: ${path}`);
  }
}

export function ensureTargetFfprobe(root, target) {
  const binary = ffprobeBinaryPath(root, target);
  if (binaryTarget(binary) !== target) {
    throw new Error(`FFprobe for ${target} is missing or wrong architecture: ${binary}; install the matching @ffprobe-installer package before packaging`);
  }
  // The package's postinstall normally adds this bit, but npm installs with
  // --ignore-scripts leave a readable Mach-O that fails every probe with EACCES.
  if (!target.startsWith('win32-')) chmodSync(binary, 0o755);
  assertTargetFfprobe(binary, target);
  console.log(`[prepare] FFprobe ready: ${target}`);
}

export function assertPackagedFfmpeg(appOutDir, target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported FFmpeg target: ${target}`);
  const resources = target.startsWith('darwin-')
    ? join(appOutDir, 'OpenChatCut.app', 'Contents', 'Resources')
    : join(appOutDir, 'resources');
  const binary = join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', target.startsWith('win32-') ? 'ffmpeg.exe' : 'ffmpeg');
  assertTargetFfmpeg(binary, target);
  console.log(`[package] FFmpeg verified: ${target}`);
}

export function assertPackagedFfprobe(appOutDir, target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported FFprobe target: ${target}`);
  const resources = target.startsWith('darwin-')
    ? join(appOutDir, 'OpenChatCut.app', 'Contents', 'Resources')
    : join(appOutDir, 'resources');
  const binary = join(resources, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', target, target.startsWith('win32-') ? 'ffprobe.exe' : 'ffprobe');
  assertTargetFfprobe(binary, target);
  console.log(`[package] FFprobe verified: ${target}`);
}
