import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPackagedFfmpeg, assertPackagedFfprobe, assertTargetFfmpeg } from './ffmpeg-package.mjs';

const root = mkdtempSync(join(tmpdir(), 'openchatcut-ffmpeg-package-'));
try {
  assert.throws(() => assertPackagedFfmpeg(root, 'darwin-arm64'), /missing or wrong architecture/);
  const binary = join(root, 'OpenChatCut.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  mkdirSync(join(binary, '..'), { recursive: true });
  const fixture = Buffer.alloc(1_000_000);
  fixture.writeUInt32LE(0xfeedfacf, 0);
  fixture.writeUInt32LE(0x0100000c, 4);
  writeFileSync(binary, fixture);
  assertPackagedFfmpeg(root, 'darwin-arm64');
  assert.throws(() => assertTargetFfmpeg(binary, 'darwin-x64'), /wrong architecture/);
  const ffprobe = join(root, 'OpenChatCut.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', 'darwin-arm64', 'ffprobe');
  mkdirSync(join(ffprobe, '..'), { recursive: true });
  writeFileSync(ffprobe, fixture);
  chmodSync(ffprobe, 0o644);
  assert.throws(() => assertPackagedFfprobe(root, 'darwin-arm64'), /not executable/);
  chmodSync(ffprobe, 0o755);
  assertPackagedFfprobe(root, 'darwin-arm64');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('FFmpeg packaging verification passed');
