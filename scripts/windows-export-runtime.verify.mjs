// Check the actual Windows package before handing its installer to another PC.
// Remotion's FFmpeg is separate from ffmpeg-static and must encode AAC itself.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows x64 is required to verify the packaged export runtime');
}

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const resources = join(root, 'release', 'win-unpacked', 'resources');
const unpacked = join(resources, 'app.asar.unpacked', 'node_modules');
const compositor = join(unpacked, '@remotion', 'compositor-win32-x64-msvc');
const sourceCompositor = join(root, 'node_modules', '@remotion', 'compositor-win32-x64-msvc');
const chrome = join(resources, 'chrome-headless-shell', 'win64',
  'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const ffmpeg = join(compositor, 'ffmpeg.exe');
const ffprobe = join(compositor, 'ffprobe.exe');
const staticFfmpeg = join(unpacked, 'ffmpeg-static', 'ffmpeg.exe');
const staticFfprobe = join(unpacked, '@ffprobe-installer', 'win32-x64', 'ffprobe.exe');
const required = [
  join(root, 'release', `OpenChatCut-${version}-x64.exe`),
  join(resources, 'app.asar'),
  join(resources, 'dist', 'index.html'),
  join(resources, 'remotion-bundle', 'index.html'),
  chrome, join(compositor, 'package.json'), ffmpeg, ffprobe, staticFfmpeg, staticFfprobe,
];
if (!existsSync(sourceCompositor)) throw new Error('Windows Remotion compositor dependency is missing');
for (const name of readdirSync(sourceCompositor).filter((name) => /\.(?:dll|exe)$/i.test(name))) {
  required.push(join(compositor, name));
}
const missing = required.filter((path) => !existsSync(path));
if (missing.length) throw new Error(`Windows installer is missing runtime files:\n${missing.join('\n')}`);
const rendererVersion = JSON.parse(readFileSync(join(root, 'node_modules', '@remotion', 'renderer', 'package.json'), 'utf8')).version;
for (const path of [join(sourceCompositor, 'package.json'), join(compositor, 'package.json')]) {
  const compositorVersion = JSON.parse(readFileSync(path, 'utf8')).version;
  if (compositorVersion !== rendererVersion) {
    throw new Error(`Remotion renderer ${rendererVersion} does not match compositor ${compositorVersion} at ${path}`);
  }
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} failed (${result.status ?? result.error?.message}):\n${result.stderr || result.stdout}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

run(staticFfmpeg, ['-version']);
if (!/\blibx264\b/.test(run(staticFfmpeg, ['-hide_banner', '-encoders']))) {
  throw new Error('Bundled media FFmpeg is missing the libx264 video encoder');
}
run(staticFfprobe, ['-version']);
run(chrome, ['--version']);
const remotionEncoders = run(ffmpeg, ['-hide_banner', '-encoders']);
for (const encoder of ['libfdk_aac', 'libx264']) {
  if (!remotionEncoders.includes(encoder)) throw new Error(`Remotion FFmpeg is missing ${encoder}`);
}
const workspace = mkdtempSync(join(tmpdir(), 'openchatcut-export-runtime-'));
try {
  const wav = join(workspace, 'sample.wav');
  const aac = join(workspace, 'sample.aac');
  const sampleRate = 48_000;
  const frames = sampleRate / 4;
  const pcm = Buffer.alloc(frames * 2 * 2);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 8000);
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(wav, Buffer.concat([header, pcm]));
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
    '-c:a', 'libfdk_aac', '-f', 'adts', '-b:a', '320k', '-cutoff', '18000', aac]);
  if (statSync(aac).size === 0) throw new Error('Remotion FFmpeg produced an empty AAC file');
  const probe = run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1', aac]);
  if (!probe.includes('codec_name=aac')) throw new Error(`Remotion FFprobe did not recognize AAC:\n${probe}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`Windows ${version} package runtime verified: compositor, DLLs, Chrome, FFmpeg, AAC encode/decode`);
