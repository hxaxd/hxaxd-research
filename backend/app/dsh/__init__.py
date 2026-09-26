"""Workbench-side adapter seam notes for DSH.

The Python backend does not speak to DSH over the network: DSH's `/api`
channel sits behind a browser-session fence, and per AGENTS.md this backend
only owns project relations while DSH keeps workspaces and session history.

The workspace binding works like this:

1. `ProjectService.create_project` allocates the managed directory and the
   registry row (workspace still unbound).
2. Our UI plugin (frontend/) calls the upstream workspace controller client
   — `ctx.workspaces.create({path})`, idempotent per canonical directory
   path — through the loaded upstream services, then renames the workspace
   to the project name.
3. The plugin binds the returned workspace id back with
   `PATCH /api/projects/{id}/workspace`; step 2 and 3 are safe to retry.
"""

BRIDGE_ENSURE_WORKSPACE_PATH = "/api/hxaxd/ensure-workspace"
