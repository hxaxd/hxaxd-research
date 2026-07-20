from __future__ import annotations

from io import BytesIO

from pypdf import PdfWriter

PAPER = {
    "paper": {
        "title": "A Complete Example Paper",
        "title_zh": "一篇完整的示例论文",
        "authors": ["Ada Example", "Lin Test"],
        "abstract": "A verified example.",
        "publication_year": 2026,
        "venue": "ExampleConf",
        "publication_state": "published",
        "identifiers": [{"scheme": "doi", "value": "10.0000/example"}],
        "links": [{"type": "paper", "url": "https://example.com/paper"}],
    },
    "project": {
        "status": "included",
        "roles": ["方法"],
        "summary": "验证论文记录写入链路。",
        "contributions": ["提供可验证的端到端测试记录。"],
        "relevance": "覆盖新论文模型。",
        "reading_focus": ["数据模型与验证流程"],
    },
}

DISCOVERED_PAPER = {
    "paper": {
        "title": "A Lightweight Candidate",
        "authors": ["Ada Example"],
        "identifiers": [{"scheme": "arxiv", "value": "2601.01234v2"}],
    },
    "project": {"status": "discovered"},
}


def _pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


PDF = _pdf()


def create_paper(client, payload=PAPER):
    project = client.post("/api/projects", json={"name": "测试领域"}).json()
    response = client.post(
        f"/api/projects/{project['id']}/papers/batch", json={"papers": [payload]}
    )
    assert response.status_code == 201, response.text
    return project, response.json()["results"][0]["paper"]


def create_paper_with_original(client):
    _, paper = create_paper(client)
    response = client.post(
        f"/api/papers/{paper['id']}/resources",
        data={"format": "pdf", "representation": "original", "origin": "user"},
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return paper
