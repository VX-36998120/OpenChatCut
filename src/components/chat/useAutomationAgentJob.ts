import { useEffect, useRef } from 'react';
import type { AgentController } from '../../agent/useAgent';
import type { ServerRunStart, ServerRunTerminal, ServerRunTerminalResolution } from '../../agent/serverRunProtocol';
import { getAgentModelSnapshot, selectAgentModel } from '../../agent/model-selection';
import { setAgentAutoApply } from '../../agent/approval-mode';
import { saveChatAutoApply } from '../../persist/sessionPrefs';

interface Job {
  job_id: string;
  project_id: string;
  prompt: string;
  skill?: string;
  model?: { backend: string; provider: string; model_id: string };
  status: 'queued' | 'editing' | 'exporting' | 'succeeded' | 'failed' | 'cancelled';
}

const route = (id: string) => `/api/automation/v1/jobs/${encodeURIComponent(id)}`;

async function request<T>(url: string, method = 'GET', input?: object): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    cache: 'no-store',
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Automation HTTP ${response.status}`);
  return result;
}

/** An automation browser tab opts in through its URL; ordinary chats never claim jobs. */
export function useAutomationAgentJob(projectId: string, agent: AgentController,
                                      setAutoApply: (value: boolean) => void) {
  const agentRef = useRef(agent);
  const autoApplyRef = useRef(setAutoApply);
  const activeRef = useRef<string | null>(null);
  const runRef = useRef<string | null>(null);
  agentRef.current = agent;
  autoApplyRef.current = setAutoApply;

  const callbacks = {
    onStart: (run: ServerRunStart) => {
      if (!activeRef.current) return;
      runRef.current = run.runId;
      void request(route(activeRef.current) + '/progress', 'POST', {
        project_id: projectId, agent_run_id: run.runId, progress: 10,
      }).catch(() => undefined);
    },
    onTerminal: (terminal: ServerRunTerminal, resolution: ServerRunTerminalResolution | false) => {
      if (!activeRef.current || terminal.runId !== runRef.current) return;
      const id = activeRef.current;
      const disposition = typeof resolution === 'object' ? resolution.disposition : resolution;
      const complete = terminal.status === 'completed' && disposition === 'finalized';
      void request(route(id) + '/update', 'POST', complete
        ? { project_id: projectId, status: 'exporting', agent_run_id: terminal.runId, progress: 85 }
        : { project_id: projectId, status: 'failed', agent_run_id: terminal.runId,
            error: terminal.status === 'awaiting_user'
              ? 'Agent requested user input: ' + terminal.assistantText.slice(0, 600)
              : terminal.assistantText.slice(0, 600) || `Agent ${terminal.status} (${disposition})` },
      ).catch(() => undefined);
    },
  };

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('automation_job');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let closed = false;
    let checking = false;
    const poll = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const job = await request<Job>(route(id));
        if (job.project_id !== projectId) throw new Error('Automation project mismatch');
        if (job.status === 'cancelled') {
          if (activeRef.current === id) agentRef.current.stop();
          activeRef.current = null;
          return;
        }
        if (job.status !== 'queued' || activeRef.current) return;
        if (!agentRef.current.hydrated || agentRef.current.running) return;
        const models = getAgentModelSnapshot();
        if (!models.loaded) return;
        if (job.model) {
          const choice = models.choices.find((candidate) => candidate.backend === job.model?.backend
            && (candidate.backend === 'copilot' || candidate.provider === job.model?.provider)
            && candidate.model === job.model?.model_id);
          if (!choice) throw new Error('Requested model is unavailable in this OpenChatCut editor');
          selectAgentModel(choice.id);
        }
        await request<Job>(route(id) + '/claim', 'POST', { project_id: projectId });
        activeRef.current = id;
        saveChatAutoApply(projectId, true);
        setAgentAutoApply(true);
        autoApplyRef.current(true);
        const prompt = job.skill
          ? `请先加载并遵循工作流技能 ${job.skill}。\n\n${job.prompt}`
          : job.prompt;
        await agentRef.current.send(prompt, { askOnly: false, references: [] });
      } catch (error) {
        if (!closed) {
          void request(route(id) + '/update', 'POST', {
            project_id: projectId, status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
        }
      } finally {
        checking = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { closed = true; window.clearInterval(timer); };
  }, [projectId]);
  return callbacks;
}
