# Local native Agent automation API

This fork adds a small, separate automation module in `server/automation/jobs.ts` and an opt-in editor worker in `src/components/chat/useAutomationAgentJob.ts`. The worker calls the same Agent controller and native tool executor as an ordinary OpenChatCut chat. No editing tool list is copied into the caller.

The API is local to OpenChatCut. Requests from another local process use `Authorization: Bearer <OpenChatCut MCP token>`. The token is the same one used by the existing external MCP integration. Keep it private. Browser editor requests use OpenChatCut's existing loopback/Origin policy.

## Job flow

1. Start OpenChatCut and create a project with its existing MCP interface. Import the media into that project. Media file paths and asset IDs should refer to the imported material.
2. `POST /api/automation/v1/jobs` with the project ID, prompt, optional skill and model, and output settings. The response contains `job_id`.
3. Open `http://127.0.0.1:5199/?automation_job=<job_id>#/editor/<project_id>` in an editor browser session. The editor claims the job and sends the prompt to its native Agent. The browser must stay open while the Agent runs because it executes editor tools there.
4. Poll `GET /api/automation/v1/jobs/<job_id>`. The job moves from `queued` to `editing` to `exporting`, or `failed`/`cancelled`. The Agent's final edit is saved before `exporting` is reported.
5. When `exporting`, call OpenChatCut's existing `/export/job` API using the saved project. Save the resulting video to the requested `output.path`, then `POST /api/automation/v1/jobs/<job_id>/update` with `{"status":"succeeded","export_path":"/absolute/output.mp4"}`. On export failure, send `{"status":"failed","error":"..."}`.

The Collector integration performs steps 1, 3 and 5. OpenChatCut runs the native Agent and renders the video. The API cannot render an arbitrary source path by itself: the caller first imports the media and opens the editor worker. This follows OpenChatCut's current editor tool architecture.

## Create request

```json
{
  "project_id": "existing-project-id",
  "prompt": "Edit the imported material into a short vertical video.",
  "skill": "long-video-to-shorts",
  "media_paths": ["/absolute/source.mp4"],
  "asset_ids": ["imported-asset-id"],
  "model": {"backend": "api", "provider": "deepseek", "model_id": "configured-model"},
  "output": {"path": "/absolute/output.mp4", "resolution": "1080p", "fps": 30,
             "format": "video", "codec": "h264"}
}
```

`skill` and `model` are optional. When a model is specified, the editor selects that exact configured model and fails if unavailable. `skill` is a bundled or installed OpenChatCut skill slug; the native Agent is instructed to load it. The prompt remains the caller's editing requirements. `media_paths` and `asset_ids` record the sources for traceability; they do not import files by themselves.

`GET /api/automation/v1/jobs?project_id=<id>` lists jobs for a project. `POST /api/automation/v1/jobs/<job_id>/cancel` cancels a pending or active job; the editor stops an active Agent, and the Collector cancels an active export. `POST /api/automation/v1/jobs/<job_id>/progress` records the Agent run ID or export job ID and approximate stage progress. Each job reports `job_id`, `project_id`, `status`, `stage`, `progress`, `agent_run_id` when started, `export_job_id` during export, `export_path` on success, `error` on failure, and timestamps. State is saved in OpenChatCut's runtime profile.

## Upstream upgrades

Keep this module on a branch in your fork. Merge or rebase new upstream `main` into the branch, resolve any changes to `server/plugins/index.ts`, `chatPanelController.ts`, and `useChatAgentController.ts`, then rebuild. The API module uses existing OpenChatCut authentication, project storage, Agent and export interfaces. Compatibility still needs checking after upstream changes to those interfaces.
