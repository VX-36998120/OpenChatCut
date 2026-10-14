import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { externalMcpAuthorized, trustedEditorRequest } from '../editor-auth.ts';
import { runtimeProfile } from '../runtime-profile.ts';

type JobStatus = 'queued' | 'editing' | 'exporting' | 'succeeded' | 'failed' | 'cancelled';
type JobStage = 'waiting_for_editor' | 'agent' | 'export' | 'complete';

export interface AutomationJob {
  job_id: string;
  project_id: string;
  prompt: string;
  skill?: string;
  media_paths: string[];
  asset_ids: string[];
  model?: { backend: string; provider: string; model_id: string };
  output: { path: string; resolution: string; fps: number; format: string; codec: string };
  status: JobStatus;
  stage: JobStage;
  progress: number | null;
  agent_run_id?: string;
  export_job_id?: string;
  export_path?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

const jobs = new Map<string, AutomationJob>();
let loaded = false;
let pendingWrite: Promise<void> = Promise.resolve();
const identifier = /^[A-Za-z0-9_-]{1,160}$/;
const jobFile = () => join(runtimeProfile().rootDir, 'automation-jobs-v1.json');

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function load(): Promise<void> {
  if (loaded) return;
  try {
    const data: unknown = JSON.parse(await readFile(jobFile(), 'utf8'));
    if (Array.isArray(data)) for (const item of data) {
      if (item && typeof item === 'object' && typeof item.job_id === 'string') {
        const job = item as AutomationJob;
        // An editor process cannot be assumed to survive an application restart.
        if (job.status === 'editing') {
          job.status = 'failed';
          job.error = 'The editor disconnected before reporting the Agent result.';
        }
        jobs.set(job.job_id, job);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  loaded = true;
}

async function persist(): Promise<void> {
  pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
    const file = jobFile();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...jobs.values()]), { mode: 0o600 });
    await rename(temporary, file);
  });
  await pendingWrite;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 128 * 1024) throw new Error('request body too large');
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}

function strings(value: unknown, limit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('invalid media paths or asset ids');
  }
  return value;
}

function validate(input: Record<string, unknown>): AutomationJob {
  const projectId = input.project_id;
  const prompt = input.prompt;
  if (typeof projectId !== 'string' || !identifier.test(projectId)) throw new Error('valid project_id required');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 40_000) throw new Error('prompt required (maximum 40000 characters)');
  const mediaPaths = strings(input.media_paths, 100);
  const assetIds = strings(input.asset_ids, 100);
  const skill = input.skill;
  if (skill !== undefined && (typeof skill !== 'string' || !/^[a-z0-9-]{1,100}$/.test(skill))) throw new Error('invalid skill');
  const requestedModel = input.model;
  let model: AutomationJob['model'];
  if (requestedModel !== undefined) {
    if (!requestedModel || typeof requestedModel !== 'object' || Array.isArray(requestedModel)) throw new Error('invalid model');
    const value = requestedModel as Record<string, unknown>;
    if (['backend', 'provider', 'model_id'].some((key) => typeof value[key] !== 'string' || !(value[key] as string).trim())) throw new Error('invalid model');
    model = { backend: value.backend as string, provider: value.provider as string, model_id: value.model_id as string };
  }
  const requestedOutput = input.output;
  if (!requestedOutput || typeof requestedOutput !== 'object' || Array.isArray(requestedOutput)) throw new Error('output required');
  const output = requestedOutput as Record<string, unknown>;
  if (typeof output.path !== 'string' || !output.path.trim()) throw new Error('output.path required');
  const fps = output.fps === undefined ? 30 : Number(output.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('invalid output.fps');
  const now = new Date().toISOString();
  return {
    job_id: randomUUID(), project_id: projectId, prompt: prompt.trim(),
    ...(skill ? { skill } : {}), media_paths: mediaPaths, asset_ids: assetIds,
    ...(model ? { model } : {}),
    output: {
      path: output.path, resolution: typeof output.resolution === 'string' ? output.resolution : '1080p',
      fps, format: typeof output.format === 'string' ? output.format : 'video',
      codec: typeof output.codec === 'string' ? output.codec : 'h264',
    },
    status: 'queued', stage: 'waiting_for_editor', progress: null,
    created_at: now, updated_at: now,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await load();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const browser = trustedEditorRequest(req, req.method !== 'GET');
    const external = externalMcpAuthorized(req);
    if (!browser && !external) return send(res, 403, { error: 'automation access denied' });
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'jobs') {
      if (!external) return send(res, 403, { error: 'external credential required' });
      const job = validate(await body(req));
      jobs.set(job.job_id, job);
      await persist();
      return send(res, 201, job);
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'jobs') {
      const project = url.searchParams.get('project_id');
      if (browser && !external && (!project || !identifier.test(project))) {
        return send(res, 400, { error: 'project_id required' });
      }
      return send(res, 200, { jobs: [...jobs.values()].filter((job) => !project || job.project_id === project) });
    }
    const id = parts[1] ?? '';
    const job = jobs.get(id);
    if (!job || parts[0] !== 'jobs') return send(res, 404, { error: 'job not found' });
    if (req.method === 'GET' && parts.length === 2) return send(res, 200, job);
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'claim') {
      if (!browser) return send(res, 403, { error: 'editor origin required' });
      const input = await body(req);
      if (input.project_id !== job.project_id) return send(res, 409, { error: 'project mismatch' });
      if (job.status !== 'queued') return send(res, 409, { error: 'job is not queued' });
      job.status = 'editing'; job.stage = 'agent'; job.updated_at = new Date().toISOString();
      await persist();
      return send(res, 200, job);
    }
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
      if (!external) return send(res, 403, { error: 'external credential required' });
      if (job.status === 'cancelled') return send(res, 200, job);
      if (job.status === 'succeeded' || job.status === 'failed') return send(res, 409, { error: 'job already finished' });
      job.status = 'cancelled'; job.error = 'Cancelled by the caller'; job.updated_at = new Date().toISOString();
      await persist();
      return send(res, 200, job);
    }
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'progress') {
      if (!browser) return send(res, 403, { error: 'editor origin required' });
      const input = await body(req);
      if (input.project_id !== job.project_id) return send(res, 409, { error: 'project mismatch' });
      if (job.status !== 'editing') return send(res, 409, { error: 'job is not editing' });
      const progress = Number(input.progress);
      if (!Number.isFinite(progress) || progress < 0 || progress > 84) return send(res, 400, { error: 'invalid progress' });
      job.progress = progress;
      if (typeof input.agent_run_id === 'string' && identifier.test(input.agent_run_id)) {
        job.agent_run_id = input.agent_run_id;
      }
      job.updated_at = new Date().toISOString();
      await persist();
      return send(res, 200, job);
    }
    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'update') {
      if (!browser && !external) return send(res, 403, { error: 'not authorized' });
      const input = await body(req);
      if (browser && input.project_id !== job.project_id) return send(res, 409, { error: 'project mismatch' });
      if (job.status === 'cancelled') return send(res, 409, { error: 'job cancelled' });
      if (input.status === 'exporting' && job.status === 'editing') {
        job.status = 'exporting'; job.stage = 'export'; job.progress = 85;
        if (typeof input.agent_run_id === 'string' && identifier.test(input.agent_run_id)) job.agent_run_id = input.agent_run_id;
      } else if (input.status === 'succeeded' && job.status === 'exporting' && external
        && typeof input.export_path === 'string' && input.export_path.trim()) {
        job.status = 'succeeded'; job.stage = 'complete'; job.progress = 100; job.export_path = input.export_path;
        if (typeof input.export_job_id === 'string' && identifier.test(input.export_job_id)) job.export_job_id = input.export_job_id;
      } else if (input.status === 'failed' && job.status !== 'succeeded') {
        job.status = 'failed'; job.error = String(input.error || 'Automation failed').slice(0, 1000);
      } else return send(res, 409, { error: 'invalid status transition' });
      job.updated_at = new Date().toISOString();
      await persist();
      return send(res, 200, job);
    }
    return send(res, 404, { error: 'unknown automation route' });
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'invalid request' });
  }
}

export function automationJobsPlugin(): Plugin {
  return { name: 'openchatcut-automation-jobs', configureServer(server) {
    server.middlewares.use('/api/automation/v1', (req, res) => { void handle(req, res); });
  } };
}
