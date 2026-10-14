export function ffmpegBinaryPath(root: string, target: string): string;
export function ffprobeBinaryPath(root: string, target: string): string;
export function assertTargetFfmpeg(path: string, target: string): void;
export function assertTargetFfprobe(path: string, target: string): void;
export function ensureTargetFfmpeg(root: string, target: string): void;
export function ensureTargetFfprobe(root: string, target: string): void;
export function assertPackagedFfmpeg(appOutDir: string, target: string): void;
export function assertPackagedFfprobe(appOutDir: string, target: string): void;
