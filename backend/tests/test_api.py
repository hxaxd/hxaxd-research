from __future__ import annotations

import io
import subprocess
import time
import zipfile
from pathlib import Path

from tests.sample_data import DISCOVERED_PAPER, PAPER, PDF, create_paper


def test_batch_is_idempotent_and_reuses_global_paper(client):
    first_project = client.post("/api/projects", json={"name": "项目一"}).json()
    second_project = client.post("/api/projects", json={"name": "项目二"}).json()

    first = client.post(
        f"/api/projects/{first_project['id']}/papers/batch", json={"papers": [PAPER]}
    )
    repeated = client.post(
        f"/api/projects/{first_project['id']}/papers/batch", json={"papers": [PAPER]}
    )
    reused = client.post(
        f"/api/projects/{second_project['id']}/papers/batch", json={"papers": [PAPER]}
    )

    assert first.json()["results"][0]["outcome"] == "created"
    assert repeated.json()["results"][0]["outcome"] == "unchanged"
    assert reused.json()["results"][0]["outcome"] == "reused"
    paper_ids = {
        first.json()["results"][0]["paper"]["id"],
        reused.json()["results"][0]["paper"]["id"],
    }
    assert len(paper_ids) == 1
    assert client.get("/api/projects").json()[0]["paper_count"] == 1


def test_discovered_is_lightweight_and_included_requires_relevance(client):
    project = client.post("/api/projects", json={"name": "测试领域"}).json()
    discovered = client.post(
        f"/api/projects/{project['id']}/papers/batch",
        json={"papers": [DISCOVERED_PAPER]},
    )
    assert discovered.status_code == 201
    item = discovered.json()["results"][0]
    assert item["paper"]["abstract"] is None
    rejected = client.patch(
        f"/api/projects/{project['id']}/papers/{item['paper']['id']}",
        json={"status": "included"},
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "resource_conflict"


def test_paper_schema_has_facts_and_project_judgment(client):
    schema = client.get("/api/schema/paper").json()
    submission = schema["$defs"]["PaperSubmission"]["properties"]
    assert set(submission) == {"paper", "project"}
    facts = schema["$defs"]["PaperFactsCreate"]["properties"]
    assert "identifiers" in facts
    assert "stable_key" not in facts


def test_paper_facts_can_be_corrected_without_agent_stable_key(client):
    _, paper = create_paper(client)
    response = client.patch(
        f"/api/papers/{paper['id']}",
        json={
            "title": "A Corrected Official Title",
            "identifiers": [{"scheme": "doi", "value": "https://doi.org/10.0000/CORRECTED"}],
        },
    )
    assert response.status_code == 200, response.text
    corrected = response.json()
    assert corrected["title"] == "A Corrected Official Title"
    assert corrected["identity_key"] == "doi:10.0000/corrected"


def test_pdf_and_tex_resources_are_versioned_and_preferred_can_change(client):
    _, paper = create_paper(client)
    first = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "pdf", "representation": "original", "origin": "publisher"},
        files={"upload": ("official.pdf", PDF, "application/pdf")},
    )
    second = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "pdf", "representation": "original", "origin": "user"},
        files={"upload": ("copy.pdf", PDF, "application/pdf")},
    )
    tex = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "tex", "representation": "original", "origin": "author"},
        files={"upload": ("source.zip", _tex_archive(), "application/zip")},
    )
    assert first.status_code == second.status_code == tex.status_code == 201
    resources = client.get(f"/api/papers/{paper['id']}/resources").json()
    assert len(resources) == 3
    assert sum(item["preferred"] for item in resources if item["format"] == "pdf") == 1
    switched = client.patch(f"/api/resources/{first.json()['id']}", json={"preferred": True})
    assert switched.json()["preferred"] is True
    content = client.get(f"/api/resources/{tex.json()['id']}/content")
    assert content.status_code == 200


def test_tex_path_traversal_is_rejected(client):
    _, paper = create_paper(client)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("../escape.tex", "bad")
    response = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "tex"},
        files={"upload": ("bad.zip", output.getvalue(), "application/zip")},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_resource"


def test_workspace_is_compact_and_reports_capabilities(client):
    create_paper(client)
    state = client.get("/api/workspace").json()
    assert state["contract_version"] == "2.0"
    assert state["schema_version"] == 2
    assert "papers" not in state["projects"][0]
    assert state["capabilities"]["resource_upload"]["accepts"] == ["pdf", "tex"]
    assert state["capabilities"]["compile"]["supported"] is True


def test_tex_compile_creates_a_derived_readable_pdf(client, app_settings, monkeypatch):
    _, paper = create_paper(client)
    official = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "pdf", "representation": "original", "origin": "publisher"},
        files={"upload": ("official.pdf", PDF, "application/pdf")},
    ).json()
    uploaded = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "tex", "representation": "original", "origin": "author"},
        files={"upload": ("source.zip", _tex_archive(), "application/zip")},
    ).json()
    executable = app_settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
    executable.parent.mkdir(parents=True)
    executable.touch()
    context = client.app.state.context
    monkeypatch.setattr(context.job_executor, "submit", lambda _: None)

    def fake_run(*args, **options):
        command = options.get("args") or args[0]
        output_arguments = [item for item in command if item.startswith("-outdir=")]
        if output_arguments:
            output = Path(output_arguments[0].removeprefix("-outdir="))
            (output / "main.pdf").write_bytes(PDF)
        return subprocess.CompletedProcess(command, 0, "compiled", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    job = client.post(
        "/api/jobs",
        json={"operation": "compile", "input_resource_id": uploaded["id"], "options": {}},
    ).json()
    context.job_executor._run(job["id"])
    completed = client.get(f"/api/jobs/{job['id']}").json()
    assert completed["status"] == "succeeded", completed
    assert completed["outputs"][0]["parent_resource_id"] == uploaded["id"]
    assert completed["outputs"][0]["format"] == "pdf"
    assert completed["outputs"][0]["preferred"] is False
    listed = client.get(f"/api/papers/{paper['id']}/resources").json()
    assert next(item for item in listed if item["id"] == official["id"])["preferred"] is True
    translation = client.post(
        "/api/jobs",
        json={
            "operation": "translate",
            "input_resource_id": completed["outputs"][0]["id"],
            "options": {},
        },
    )
    assert translation.status_code == 202, translation.text


def test_translation_requires_original_pdf(client):
    _, paper = create_paper(client)
    response = client.post(f"/api/papers/{paper['id']}/translate", json={})
    assert response.status_code == 404


def test_snapshot_api_creates_downloads_and_restores(client):
    project = client.post("/api/projects", json={"name": "备份测试"}).json()
    started = client.post("/api/snapshots")
    assert started.status_code == 202
    overview = _wait_for_snapshot_operation(client)
    assert overview["operation"]["status"] == "succeeded"
    snapshot = overview["snapshots"][0]
    assert client.get(snapshot["download_url"]).content.startswith(b"PK")
    client.post("/api/projects", json={"name": "恢复后应消失"})
    restored = client.post(
        f"/api/snapshots/{snapshot['filename']}/restore",
        json={"confirmation": snapshot["filename"]},
    )
    assert restored.status_code == 202
    assert _wait_for_snapshot_operation(client)["operation"]["status"] == "succeeded"
    assert [item["id"] for item in client.get("/api/projects").json()] == [project["id"]]


def _tex_archive() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "main.tex",
            r"\documentclass{article}\begin{document}Hello\end{document}",
        )
    return output.getvalue()


def _wait_for_snapshot_operation(client) -> dict:
    for _ in range(500):
        overview = client.get("/api/snapshots").json()
        if overview["operation"]["status"] != "running":
            return overview
        time.sleep(0.01)
    raise AssertionError("snapshot operation did not finish")
