from __future__ import annotations

import json
import os
import socket
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Thread
from typing import Any

import httpx
import pytest
import uvicorn

from app.core.config import Settings
from app.integrations.zotero.models import (
    BibliographicDraft,
    SyncBaseline,
    TransferCandidate,
    TransferDirection,
    TransferPlanRequest,
    TransferStatus,
    ZoteroLibraryKind,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner, fingerprint
from app.main import create_app

LIVE_AGENT_TESTS = os.environ.get("HXAXD_RUN_LIVE_AGENT_TESTS") == "1"
RUNTIME_IDS = ("pi", "opencode", "claude-code")
TERMINAL_RUN_STATUSES = {"completed", "failed", "canceled"}
RUN_TIMEOUT_SECONDS = max(
    30.0,
    float(os.environ.get("HXAXD_LIVE_AGENT_TIMEOUT_SECONDS", "240")),
)

pytestmark = pytest.mark.skipif(
    not LIVE_AGENT_TESTS,
    reason="set HXAXD_RUN_LIVE_AGENT_TESTS=1 to run real agent/model acceptance",
)


@dataclass(frozen=True)
class _Seed:
    project_id: str
    project_work_id: str
    project_work_updated_at: str
    work_id: str
    item_id: str
    item_revision: int
    preview_id: str
    preview_hash: str
    conflict_id: str


@contextmanager
def _running_live_app(tmp_path: Path) -> Iterator[tuple[Any, str]]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = int(listener.getsockname()[1])
    base_url = f"http://127.0.0.1:{port}"
    data_dir = (tmp_path / "data").resolve()
    base = Settings.from_environment()
    settings = replace(
        base,
        data_dir=data_dir,
        database_path=data_dir / "research.sqlite3",
        artifact_dir=data_dir / "artifacts",
        tools_dir=(tmp_path / "tools").resolve(),
        snapshot_dir=(tmp_path / "snapshots").resolve(),
        agent_runtime_dir=(tmp_path / "agent-work-dir").resolve(),
        frontend_origins=(base_url,),
        public_base_url=base_url,
        agent_base_url=base_url,
        lan_access_enabled=False,
        allowed_hosts=("127.0.0.1", "localhost"),
    )
    application = create_app(settings)
    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host="127.0.0.1",
            port=port,
            log_level="error",
            access_log=False,
            lifespan="on",
            timeout_graceful_shutdown=10,
        )
    )
    thread = Thread(
        target=server.run,
        kwargs={"sockets": [listener]},
        name="live-agent-acceptance-server",
        daemon=True,
    )
    thread.start()
    try:
        deadline = time.monotonic() + 30
        while not server.started:
            if not thread.is_alive():
                raise RuntimeError("temporary live-agent server failed during startup")
            if time.monotonic() >= deadline:
                raise RuntimeError("temporary live-agent server did not become ready")
            time.sleep(0.05)
        yield application, base_url
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        if thread.is_alive():
            server.force_exit = True
            thread.join(timeout=10)
        with suppress(OSError):
            listener.close()
        if thread.is_alive():
            raise RuntimeError("temporary live-agent server thread did not stop")


def _json_request(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    expected_status: int,
    payload: dict[str, Any] | None = None,
) -> Any:
    response = client.request(method, path, json=payload)
    assert response.status_code == expected_status, (
        f"{method} {path} returned HTTP {response.status_code}"
    )
    return response.json()


def _seed_workspace(client: httpx.Client, context: Any) -> _Seed:
    project = _json_request(
        client,
        "POST",
        "/api/projects",
        expected_status=201,
        payload={
            "name": "Live agent capability acceptance",
            "description": "Ephemeral data owned by the opt-in live test.",
        },
    )
    candidate = _json_request(
        client,
        "POST",
        f"/api/projects/{project['id']}/candidates",
        expected_status=201,
        payload={
            "item": {
                "item_type": "journalArticle",
                "title": "Attention Is All You Need — live acceptance seed",
                "abstract": "An immutable seed record for real agent capability testing.",
                "issued_year": 2017,
                "language": "en",
            },
            "source_provider": "live-acceptance-seed",
            "source_external_key": "live-acceptance-seed-item",
            "source_url": "https://arxiv.org/abs/1706.03762",
        },
    )
    decision = _json_request(
        client,
        "POST",
        f"/api/projects/{project['id']}/candidate-decisions",
        expected_status=200,
        payload={
            "decisions": [
                {
                    "candidate_id": candidate["id"],
                    "decision": "include",
                    "reason": "Create the immutable live-test seed item.",
                }
            ]
        },
    )[0]
    project_work = decision["project_item"]
    item_id = project_work["preferred_item_id"]
    item = context.catalog.get_item(item_id)

    old_source = BibliographicDraft(
        external_key="LIVE-SOURCE",
        external_version=1,
        item_type="journalArticle",
        title="Shared baseline title",
    )
    old_target = BibliographicDraft(
        external_key="LIVE-TARGET",
        external_version=1,
        item_type="journalArticle",
        title="Shared baseline title",
    )
    source = old_source.model_copy(
        update={"external_version": 2, "title": "Changed source title"}
    )
    target = old_target.model_copy(
        update={"external_version": 2, "title": "Changed target title"}
    )
    preview = ZoteroDiffPlanner().plan(
        TransferPlanRequest(
            direction=TransferDirection.IMPORT,
            library=ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="live-test"),
            project_id=project["id"],
            items=[
                TransferCandidate(
                    item_id=item_id,
                    source=source,
                    target=target,
                    baseline=SyncBaseline(
                        source_hash=fingerprint(old_source).content_hash,
                        target_hash=fingerprint(old_target).content_hash,
                        source_version=old_source.external_version,
                        target_version=old_target.external_version,
                    ),
                )
            ],
        )
    )
    assert preview.summary.conflict == 1
    context.zotero_service.repository.save_preview(preview)
    return _Seed(
        project_id=project["id"],
        project_work_id=project_work["id"],
        project_work_updated_at=project_work["updated_at"],
        work_id=project_work["work_id"],
        item_id=item_id,
        item_revision=item.revision,
        preview_id=preview.id,
        preview_hash=preview.preview_hash,
        conflict_id=preview.items[0].conflicts[0].id,
    )


def _common_read_steps(seed: _Seed) -> str:
    return f"""
1. 调用 workspace_summary，参数为空对象。
2. 调用 get_project，project_id 必须是 {seed.project_id}。
3. 调用 list_project_works，project_id 必须是 {seed.project_id}，limit=20，offset=0。
4. 调用 get_bibliographic_item，item_id 必须是 {seed.item_id}。
5. 调用 list_candidates，project_id 必须是 {seed.project_id}，limit=20，offset=0。
""".strip()


def _goal(task_kind: str, runtime_id: str, seed: _Seed) -> str:
    prefix = f"""
这是 HXAXD 的真实自动验收回合，运行时标识为 {runtime_id}。
必须严格逐项调用下面列出的每一个工具；不得省略、替代、只描述调用或提前结束。
每个工具只调用一次，等待工具返回后再继续。工具参数必须采用下面给出的精确值。
不得读取文件、数据库或环境变量，不得调用未列出的工具。
{_common_read_steps(seed)}
""".strip()
    if task_kind == "literature_search":
        return (
            prefix
            + f"""

6. 调用 web_search：query="Attention Is All You Need transformer"，limit=2，
   intent="academic"。
7. 调用 stage_candidate，使用以下精确核心参数：
   project_id="{seed.project_id}"；source_provider="live-acceptance-{runtime_id}"；
   source_external_key="live-acceptance-candidate-{runtime_id}"；
   source_url="https://arxiv.org/abs/1706.03762"；rank=1；
   rationale="Real live capability acceptance for {runtime_id}."；
   item={{"item_type":"journalArticle",
   "title":"LIVE CAPABILITY CANDIDATE {runtime_id}","issued_year":2017,
   "language":"en"}}。
绝对不得收录、排除、归档或删除候选。全部完成后只回复 LIVE_ACCEPTANCE_OK。
"""
        )
    if task_kind == "metadata_enrichment":
        return (
            prefix
            + f"""

6. 调用 web_search：query="Attention Is All You Need DOI metadata"，limit=2，
   intent="metadata"。
7. 调用 propose_metadata_patch：base_revision={seed.item_revision}；
   item_id="{seed.item_id}"；
   patch={{"abstract":"LIVE METADATA PROPOSAL {runtime_id}"}}；
   summary="Live metadata proposal from {runtime_id}"；
   rationale="Exercise the typed metadata proposal capability."；
   evidence=[{{"source":"arXiv","url":"https://arxiv.org/abs/1706.03762"}}]。
8. 调用 propose_project_insights：project_work_id="{seed.project_work_id}"；
   work_id="{seed.work_id}"；base_updated_at="{seed.project_work_updated_at}"；
   patch={{"summary":"LIVE PROJECT INSIGHT {runtime_id}",
   "reading_focus":["Verify the attention mechanism"]}}；
   summary="Live project insight proposal from {runtime_id}"；
   rationale="Exercise the typed project-insight proposal capability."；
   evidence=[{{"source":"arXiv","url":"https://arxiv.org/abs/1706.03762"}}]。
只能提交建议，绝对不得批准或应用变更。全部完成后只回复 LIVE_ACCEPTANCE_OK。
"""
        )
    if task_kind == "resource_acquisition":
        return (
            prefix
            + f"""

6. 调用 web_search：query="Attention Is All You Need arXiv PDF"，limit=2，
   intent="open_access"。
7. 调用 propose_resource_acquisition：base_revision={seed.item_revision}；
   item_id="{seed.item_id}"；
   request={{"url":"https://arxiv.org/pdf/1706.03762.pdf",
   "filename":"live-acceptance-{runtime_id}.pdf","attachment_type":"fulltext",
   "language_mode":"original","origin":"preprint","preferred_for":[]}}；
   summary="Live resource proposal from {runtime_id}"；
   rationale="Exercise the typed resource proposal without downloading."；
   evidence=[{{"source":"arXiv","url":"https://arxiv.org/abs/1706.03762"}}]。
只能提交资源建议，绝对不得下载、批准或应用。全部完成后只回复 LIVE_ACCEPTANCE_OK。
"""
        )
    if task_kind == "conflict_resolution":
        return (
            prefix
            + f"""

6. 调用 get_zotero_transfer_preview，preview_id 必须是 {seed.preview_id}。
7. 调用 propose_zotero_conflict_resolution：preview_id="{seed.preview_id}"；
   expected_preview_hash="{seed.preview_hash}"；
   resolution={{"conflict_id":"{seed.conflict_id}","choice":"target"}}；
   summary="Live Zotero conflict proposal from {runtime_id}"；
   rationale="Keep the target in this non-executing acceptance test."；evidence=[]。
只能提交冲突建议，绝对不得保存真实 resolution 或执行迁移。
全部完成后只回复 LIVE_ACCEPTANCE_OK。
"""
        )
    raise AssertionError(f"unsupported live task kind: {task_kind}")


def _launch_payload(task_kind: str, runtime_id: str, seed: _Seed) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "task_kind": task_kind,
        "goal": _goal(task_kind, runtime_id, seed),
        "runtime": runtime_id,
        "project_id": seed.project_id,
        "item_id": seed.item_id,
    }
    if task_kind == "conflict_resolution":
        payload["zotero_preview_id"] = seed.preview_id
    return payload


def _wait_for_run(
    client: httpx.Client,
    context: Any,
    run_id: str,
    runtime_id: str,
) -> Any:
    deadline = time.monotonic() + RUN_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        run = context.agent_repository.get(run_id)
        if run.status.value in TERMINAL_RUN_STATUSES:
            assert run.status.value == "completed", (
                f"{runtime_id} live run ended as {run.status.value} "
                f"with code {run.error_code or 'none'}"
            )
            return run
        for approval in context.agent_repository.pending_approvals(run_id):
            assert approval.approvable, (
                f"{runtime_id} requested a non-approvable live-test permission"
            )
            _json_request(
                client,
                "POST",
                f"/api/approvals/{approval.id}/approve",
                expected_status=200,
            )
        time.sleep(0.2)
    with suppress(Exception):
        _json_request(
            client,
            "POST",
            f"/api/agent-runs/{run_id}/interrupt",
            expected_status=202,
        )
    raise AssertionError(f"{runtime_id} live run exceeded {RUN_TIMEOUT_SECONDS:g} seconds")


def _normalized_tool_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    for prefix in ("mcp__hxaxd__", "hxaxd_"):
        if value.startswith(prefix):
            return value[len(prefix) :]
    return value


def _assert_tool_audit(context: Any, run: Any) -> None:
    events = context.agent_repository.list_events(run.id, limit=5000)
    completed: set[str] = set()
    failed: set[str] = set()
    for event in events:
        if not event.event_type.startswith("mcp_tool.audit"):
            continue
        tool = _normalized_tool_name(event.payload.get("tool"))
        if tool is None:
            continue
        status = str(event.payload.get("status", "")).casefold()
        if event.event_type.endswith(".completed") or status == "completed":
            completed.add(tool)
        if event.event_type.endswith(".failed") or status in {
            "failed",
            "cancelled",
            "canceled",
        }:
            failed.add(tool)
    expected = set(context.agent_prompt_context.tools_for_scopes(run.tool_scopes))
    assert not failed, f"{run.runtime} had failed audited tools: {sorted(failed)}"
    assert expected <= completed, (
        f"{run.runtime} omitted audited tools: {sorted(expected - completed)}"
    )
    assert run.provider_thread_id
    assert run.provider_turn_id
    assert run.model == "deepseek-v4-flash"
    serialized_events = json.dumps(
        [event.payload for event in events],
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    assert "Bearer " not in serialized_events


def _changes_for_run(context: Any, run_id: str) -> list[Any]:
    return [
        change
        for change in context.changes.list(limit=500, offset=0).items
        if change.agent_run_id == run_id
    ]


def test_all_live_deepseek_agent_runtimes_execute_every_scoped_capability(tmp_path) -> None:
    with _running_live_app(tmp_path) as (application, base_url):
        context = application.state.context
        with httpx.Client(base_url=base_url, timeout=15) as client:
            _json_request(client, "GET", "/api/health", expected_status=200)
            definitions = {
                item["id"]: item
                for item in _json_request(
                    client,
                    "GET",
                    "/api/agent-runtimes",
                    expected_status=200,
                )
            }
            missing = [
                runtime_id
                for runtime_id in RUNTIME_IDS
                if not definitions[runtime_id]["ready"]
            ]
            assert not missing, f"live agent runtimes are not ready: {missing}"
            assert all(
                definitions[runtime_id]["model"] == "deepseek-v4-flash"
                for runtime_id in RUNTIME_IDS
            )

            seed = _seed_workspace(client, context)
            item_before = context.catalog.get_item(seed.item_id).model_dump(mode="json")
            project_work_before = context.screening.get_project_work(
                seed.project_id, seed.work_id
            ).model_dump(mode="json")
            attachments_before = context.attachments.list_for_item(seed.item_id)
            preview_before = context.zotero_service.get_public_preview(seed.preview_id)
            candidates_before = context.screening.list_candidates(
                seed.project_id, limit=500
            ).total
            changes_before = context.changes.list(limit=500, offset=0).total

            runs: dict[tuple[str, str], Any] = {}
            for runtime_id in RUNTIME_IDS:
                for task_kind in (
                    "literature_search",
                    "metadata_enrichment",
                    "resource_acquisition",
                    "conflict_resolution",
                ):
                    launch = _json_request(
                        client,
                        "POST",
                        "/api/agent-runs",
                        expected_status=202,
                        payload=_launch_payload(task_kind, runtime_id, seed),
                    )
                    run = _wait_for_run(client, context, launch["run"]["id"], runtime_id)
                    _assert_tool_audit(context, run)
                    runs[(runtime_id, task_kind)] = run

                    changes = _changes_for_run(context, run.id)
                    expected_kinds = {
                        "literature_search": set(),
                        "metadata_enrichment": {"metadata_patch", "project_insights"},
                        "resource_acquisition": {"resource_acquisition"},
                        "conflict_resolution": {"zotero_conflict_resolution"},
                    }[task_kind]
                    assert {change.kind.value for change in changes} == expected_kinds
                    assert all(change.status.value == "submitted" for change in changes)
                    assert all(
                        item.status.value == "proposed"
                        for change in changes
                        for item in change.items
                    )

            candidates_after = context.screening.list_candidates(
                seed.project_id, limit=500
            )
            assert candidates_after.total == candidates_before + len(RUNTIME_IDS)
            candidate_titles = {candidate.item.title for candidate in candidates_after.items}
            assert {
                f"LIVE CAPABILITY CANDIDATE {runtime_id}" for runtime_id in RUNTIME_IDS
            } <= candidate_titles

            changes_after = context.changes.list(limit=500, offset=0)
            assert changes_after.total == changes_before + 4 * len(RUNTIME_IDS)
            assert context.catalog.get_item(seed.item_id).model_dump(mode="json") == item_before
            assert (
                context.screening.get_project_work(seed.project_id, seed.work_id).model_dump(
                    mode="json"
                )
                == project_work_before
            )
            assert context.attachments.list_for_item(seed.item_id) == attachments_before == []

            preview_after = context.zotero_service.get_public_preview(seed.preview_id)
            assert preview_before.state is TransferStatus.PREVIEW_READY
            assert preview_after.state is TransferStatus.PREVIEW_READY
            assert preview_after.model_dump(mode="json") == preview_before.model_dump(mode="json")
            assert preview_after.resolutions == []
            assert preview_after.receipt is None

            jobs = context.job_repository.list_jobs(limit=1000)
            assert len(jobs) == len(runs)
            assert all(job.kind == "agent.run" for job in jobs)
            assert all(job.status.value == "succeeded" for job in jobs)
