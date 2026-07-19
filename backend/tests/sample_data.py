PAPER = {
    "stable_key": "doi:10.0000/example",
    "status": "included",
    "title_en": "A Complete Example Paper",
    "title_zh": "一篇完整的示例论文",
    "authors": ["Ada Example", "Lin Test"],
    "organization": "Example University",
    "publication_year": 2026,
    "publication_status": "ExampleConf 2026",
    "paper_type": "方法",
    "main_method": "通过示例验证完整论文记录写入链路。",
    "contribution": "提供可验证的端到端测试记录。",
    "selection_reason": "覆盖论文数据模型的全部必填字段。",
    "reading_focus": "数据模型与验证流程。",
    "relations": "作为系统端到端测试的基准记录。",
    "stable_url": "https://example.com/paper",
    "code_url": None,
    "website_url": None,
}

PDF = b"%PDF-1.4\n" + (b"0" * 1200) + b"\n%%EOF\n"


def create_paper_with_original(client):
    project = client.post(
        "/api/projects",
        json={"name": "测试领域"},
    ).json()
    paper = client.post(
        f"/api/projects/{project['id']}/papers/batch", json={"papers": [PAPER]}
    ).json()["created"][0]
    response = client.post(
        f"/api/papers/{paper['id']}/artifacts/original",
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return paper
