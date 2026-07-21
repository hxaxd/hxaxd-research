from __future__ import annotations

import zipfile
from io import BytesIO
from threading import Event
from time import monotonic, sleep

import pytest

from app.catalog.models import BibliographicItemDraft
from app.documents.extractor import DocumentExtractionError, parse_babeldoc_il
from app.documents.models import (
    BlockKind,
    DocumentTranslationOutput,
    ExtractedBlock,
    ExtractedDocument,
    GlossaryOutputItem,
    SemanticRole,
    TranslationOutputItem,
)
from app.documents.ocr import parse_rapidocr_output
from app.documents.tex import (
    TexStructureError,
    TexStructureExtractor,
    parse_tex_document,
)
from app.documents.translation import (
    DocumentTranslationError,
    TranslationCapacity,
    TranslationProviderResponse,
    _consume_streaming_response,
)
from app.jobs.models import JobCreate, JobStatus

from .sample_data import PDF

TEX_SOURCE = r"""
\documentclass{article}
\title{Semantic Reading}
\begin{document}
\maketitle
\begin{abstract}
A structured abstract for the complete paper.
\end{abstract}
\section{Methods}
The method preserves every stable paragraph and citation \cite{one}.
\begin{equation}
E = mc^2
\end{equation}
\begin{figure}
\includegraphics{system.pdf}
\caption{System architecture}
\label{fig:system}
\end{figure}
\section{Results}
The results improve reading quality.
\begin{thebibliography}{9}
\bibitem{one} Ada Example. A traceable result.
\end{thebibliography}
\end{document}
"""


def _box(x: float, y: float, x2: float, y2: float) -> dict:
    return {"x": x, "y": y, "x2": x2, "y2": y2}


def test_tex_structure_drives_blocks_and_reuses_pdf_anchors() -> None:
    layout = ExtractedDocument(
        language="en",
        page_count=4,
        diagnostics={"source": "babeldoc_document_il"},
        blocks=[
            ExtractedBlock(
                kind=BlockKind.TITLE,
                source_text="Semantic Reading",
                page_start=1,
                page_end=1,
                anchor={"type": "pdf_bbox", "page": 1, "bbox": _box(10, 700, 500, 730)},
            ),
            ExtractedBlock(
                kind=BlockKind.PARAGRAPH,
                source_text="A structured abstract for the complete paper.",
                page_start=1,
                page_end=1,
                anchor={"type": "pdf_bbox", "page": 1, "bbox": _box(10, 620, 500, 680)},
            ),
            ExtractedBlock(
                kind=BlockKind.HEADING,
                source_text="Methods",
                page_start=2,
                page_end=2,
                anchor={"type": "pdf_bbox", "page": 2, "bbox": _box(10, 700, 200, 730)},
            ),
            ExtractedBlock(
                kind=BlockKind.PARAGRAPH,
                source_text="The method preserves every stable paragraph and citation [one].",
                page_start=2,
                page_end=2,
                anchor={"type": "pdf_bbox", "page": 2, "bbox": _box(10, 620, 500, 680)},
            ),
            ExtractedBlock(
                kind=BlockKind.FORMULA,
                source_text="E = mc^2",
                page_start=2,
                page_end=2,
                anchor={"type": "pdf_bbox", "page": 2, "bbox": _box(100, 540, 300, 580)},
            ),
            ExtractedBlock(
                kind=BlockKind.FIGURE,
                source_text="System architecture",
                page_start=3,
                page_end=3,
                anchor={"type": "pdf_bbox", "page": 3, "bbox": _box(20, 200, 560, 500)},
            ),
        ],
    )

    extracted = parse_tex_document(TEX_SOURCE, layout)

    assert extracted.diagnostics["structure_source"] == "tex"
    assert extracted.diagnostics["tex_pdf_anchor_matches"] >= 6
    assert [block.kind for block in extracted.blocks] == [
        BlockKind.TITLE,
        BlockKind.PARAGRAPH,
        BlockKind.HEADING,
        BlockKind.PARAGRAPH,
        BlockKind.FORMULA,
        BlockKind.FIGURE,
        BlockKind.HEADING,
        BlockKind.PARAGRAPH,
        BlockKind.REFERENCE,
    ]
    method = extracted.blocks[3]
    assert method.section_path == ["Methods"]
    assert method.semantic_role is SemanticRole.METHOD
    assert method.page_start == 2
    assert method.anchor["type"] == "pdf_bbox"
    figure = extracted.blocks[5]
    assert figure.anchor["structure_source"]["relation"] == "fig:system"
    assert figure.page_start == 3
    assert extracted.blocks[-1].section_path == ["References"]


def test_tex_archive_rejects_path_traversal(tmp_path) -> None:
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../escape.tex", TEX_SOURCE)
    layout = ExtractedDocument(page_count=1, blocks=[])

    with pytest.raises(TexStructureError, match="不安全路径"):
        TexStructureExtractor().enrich(archive, layout)


def _paragraph(
    text: str,
    *,
    label: str,
    layout_id: int,
    order: int,
    box: dict,
    debug: bool = False,
) -> dict:
    return {
        "unicode": text,
        "layout_label": label,
        "layout_id": layout_id,
        "render_order": order,
        "box": box,
        "pdf_paragraph_composition": [
            {
                "pdf_same_style_unicode_characters": {
                    "unicode": text,
                    "debug_info": debug,
                }
            }
        ],
    }


def test_babeldoc_il_parser_removes_debug_blocks_and_preserves_anchors() -> None:
    payload = {
        "total_pages": 1,
        "page": [
            {
                "page_number": 0,
                "mediabox": {"box": _box(0, 0, 595, 842)},
                "page_layout": [
                    {
                        "id": 1,
                        "class_name": "title",
                        "conf": 0.98,
                        "box": _box(60, 760, 530, 800),
                    },
                    {
                        "id": 2,
                        "class_name": "plain text",
                        "conf": 0.95,
                        "box": _box(60, 650, 530, 720),
                    },
                    {
                        "id": 3,
                        "class_name": "table",
                        "conf": 0.93,
                        "box": _box(80, 500, 510, 620),
                    },
                ],
                "pdf_paragraph": [
                    _paragraph(
                        "title",
                        label="",
                        layout_id=1,
                        order=0,
                        box=_box(60, 760, 530, 800),
                        debug=True,
                    ),
                    _paragraph(
                        "A Structured Reader",
                        label="title",
                        layout_id=1,
                        order=1,
                        box=_box(60, 760, 530, 800),
                    ),
                    _paragraph(
                        "1 Introduction",
                        label="title",
                        layout_id=1,
                        order=2,
                        box=_box(60, 725, 250, 750),
                    ),
                    _paragraph(
                        "A full document context improves consistency.",
                        label="plain text",
                        layout_id=2,
                        order=3,
                        box=_box(60, 680, 530, 710),
                    ),
                    _paragraph(
                        "Metric",
                        label="fallback_line",
                        layout_id=99,
                        order=4,
                        box=_box(90, 560, 170, 580),
                    ),
                ],
            }
        ],
    }

    document = parse_babeldoc_il(payload)

    assert document.page_count == 1
    assert document.diagnostics["ignored_debug_blocks"] == 1
    assert [block.kind for block in document.blocks] == [
        BlockKind.TITLE,
        BlockKind.HEADING,
        BlockKind.PARAGRAPH,
        BlockKind.TABLE,
    ]
    assert document.blocks[2].section_path == ["1 Introduction"]
    assert document.blocks[2].semantic_role is SemanticRole.BACKGROUND
    assert document.blocks[3].anchor["page"] == 1
    assert document.blocks[3].anchor["page_box"]["y2"] == 842


def test_babeldoc_il_parser_uses_render_order_and_available_specialized_labels() -> None:
    layouts = [
        {"id": 1, "class_name": "plain text", "box": _box(40, 100, 270, 700)},
        {"id": 2, "class_name": "plain text", "box": _box(320, 100, 550, 700)},
        {"id": 3, "class_name": "table", "box": _box(40, 30, 270, 90)},
        {"id": 4, "class_name": "figure", "box": _box(320, 30, 550, 90)},
    ]
    right = _paragraph(
        "Right column follows.",
        label="plain text",
        layout_id=2,
        order=3,
        box=_box(320, 500, 550, 540),
    )
    left = _paragraph(
        "Left column is first.",
        label="plain text",
        layout_id=1,
        order=2,
        box=_box(40, 500, 270, 540),
    )
    formula = _paragraph(
        "E = mc2",
        label="",
        layout_id=1,
        order=4,
        box=_box(40, 430, 270, 470),
    )
    formula["pdf_paragraph_composition"] = [{"pdf_formula": {"unicode": "E = mc2"}}]
    payload = {
        "total_pages": 1,
        "page": [{
            "page_number": 0,
            "mediabox": {"box": _box(0, 0, 595, 842)},
            "page_layout": layouts,
            "pdf_paragraph": [
                right,
                _paragraph(
                    "Two-column evidence",
                    label="title",
                    layout_id=1,
                    order=1,
                    box=_box(40, 740, 550, 780),
                ),
                left,
                formula,
                _paragraph(
                    "Metric 0.98",
                    label="fallback_line",
                    layout_id=3,
                    order=5,
                    box=_box(50, 45, 250, 70),
                ),
                _paragraph(
                    "Figure 1",
                    label="figure",
                    layout_id=4,
                    order=6,
                    box=_box(330, 45, 540, 70),
                ),
                _paragraph(
                    "Footnote evidence",
                    label="footnote",
                    layout_id=1,
                    order=7,
                    box=_box(40, 10, 270, 25),
                ),
            ],
        }],
    }

    document = parse_babeldoc_il(payload)

    assert [block.source_text for block in document.blocks[:3]] == [
        "Two-column evidence",
        "Left column is first.",
        "Right column follows.",
    ]
    assert [block.kind for block in document.blocks[3:]] == [
        BlockKind.FORMULA,
        BlockKind.TABLE,
        BlockKind.FIGURE,
        BlockKind.FOOTNOTE,
    ]


def test_rapidocr_parser_recovers_two_column_paragraphs_with_confidence() -> None:
    def line(text: str, x: int, y: int, x2: int, y2: int, score: float = 0.94):
        return {
            "text": text,
            "confidence": score,
            "points": [[x, y], [x2, y], [x2, y2], [x, y2]],
        }

    payload = {
        "engine": "rapidocr",
        "version": "3.9.2",
        "dpi": 200,
        "pages": [
            {
                "page_number": 1,
                "pdf_width": 500,
                "pdf_height": 800,
                "image_width": 1000,
                "image_height": 1600,
                "lines": [
                    line("A Scanned Paper", 100, 20, 900, 60, 0.99),
                    line("1 Introduction", 50, 100, 400, 128),
                    line("The first column has", 50, 145, 400, 161),
                    line("one stable paragraph.", 50, 165, 400, 181),
                    line("2 Method", 550, 100, 900, 128),
                    line("The second column is", 550, 145, 900, 161),
                    line("read after the first.", 550, 165, 900, 181),
                ],
            }
        ],
    }

    document = parse_rapidocr_output(payload)

    assert [block.kind for block in document.blocks] == [
        BlockKind.TITLE,
        BlockKind.HEADING,
        BlockKind.PARAGRAPH,
        BlockKind.HEADING,
        BlockKind.PARAGRAPH,
    ]
    assert document.blocks[2].source_text == "The first column has one stable paragraph."
    assert document.blocks[4].source_text == "The second column is read after the first."
    assert document.blocks[1].semantic_role is SemanticRole.BACKGROUND
    assert document.blocks[3].semantic_role is SemanticRole.METHOD
    assert document.blocks[2].anchor["layout"]["engine"] == "rapidocr"
    assert document.blocks[2].anchor["bbox"]["x"] == 25
    assert document.diagnostics["mean_confidence"] > 0.9


def test_streaming_translation_response_is_one_interruptible_document_response() -> None:
    response = BytesIO(
        b'data: {"choices":[{"delta":{"content":"{\\"translations\\":"},'
        b'"finish_reason":null}]}\n\n'
        b'data: {"choices":[{"delta":{"content":"[]}"},'
        b'"finish_reason":"stop"}]}\n\n'
        b"data: [DONE]\n\n"
    )
    content, finish_reason, request_id, usage = _consume_streaming_response(
        response, lambda: False
    )
    assert content == '{"translations":[]}'
    assert finish_reason == "stop"
    assert request_id is None
    assert usage == {}

    with pytest.raises(DocumentTranslationError) as failure:
        _consume_streaming_response(BytesIO(b"data: [DONE]\n\n"), lambda: True)
    assert failure.value.code == "canceled"


class _FakeExtractor:
    name = "fake-layout"
    version = "1.0"
    structure_version = "semantic-blocks-v1"
    ready = True

    def __init__(self) -> None:
        self.calls = 0

    def extract(self, _path, *, ocr_mode, callbacks):
        self.calls += 1
        callbacks.emit("fake.extract", {"ocr_mode": ocr_mode.value}, "info")
        return ExtractedDocument(
            language="en",
            page_count=1,
            blocks=[
                ExtractedBlock(
                    kind=BlockKind.TITLE,
                    source_text="Whole-document translation",
                    page_start=1,
                    page_end=1,
                    anchor={"page": 1, "bbox": _box(10, 700, 500, 730)},
                ),
                ExtractedBlock(
                    kind=BlockKind.PARAGRAPH,
                    source_text=(
                        "The method preserves every stable block identifier, cites [1], "
                        "keeps $x_i$, and links https://example.org."
                    ),
                    page_start=1,
                    page_end=1,
                    anchor={"page": 1, "bbox": _box(10, 650, 500, 680)},
                    section_path=["Method"],
                ),
                ExtractedBlock(
                    kind=BlockKind.FORMULA,
                    source_text="E = mc^2",
                    page_start=1,
                    page_end=1,
                    anchor={"page": 1, "bbox": _box(10, 600, 150, 620)},
                    section_path=["Method"],
                ),
            ],
        )


class _FakeProvider:
    name = "deepseek"
    model = "deepseek-v4-flash"
    ready = True
    capacity = TranslationCapacity(
        max_input_characters=1_000_000, max_output_tokens=384_000
    )

    def __init__(self) -> None:
        self.calls: list[list] = []
        self.invalid = False

    def translate_document(
        self,
        blocks,
        target_language,
        *,
        model,
        style,
        glossary,
        document_outline,
        batch_label,
        preceding_context,
        following_context,
        cancellation,
    ):
        assert not cancellation()
        self.calls.append(list(blocks))
        selected = blocks[:-1] if self.invalid else blocks
        return TranslationProviderResponse(
            output=DocumentTranslationOutput(
                translations=[
                    TranslationOutputItem(
                        id=block.id,
                        translated_text=f"{target_language}：{block.source_text}",
                        semantic_role=(
                            SemanticRole.METHOD
                            if block.kind is BlockKind.PARAGRAPH
                            else SemanticRole.OTHER
                        ),
                    )
                    for block in selected
                ],
                glossary=[
                    GlossaryOutputItem(
                        source_term="stable block",
                        translated_term="稳定块",
                    )
                ],
                detected_source_language="en",
            ),
            request_id=f"request-{len(self.calls)}",
            usage={"total_tokens": 100},
        )


class _CancelableExtractor(_FakeExtractor):
    name = "cancelable-layout"

    def __init__(self) -> None:
        super().__init__()
        self.entered = Event()

    def extract(self, _path, *, ocr_mode, callbacks):
        self.entered.set()
        assert callbacks.cancellation.wait(3)
        raise DocumentExtractionError("canceled", "提取已取消", retryable=True)


class _CancelableProvider(_FakeProvider):
    name = "deepseek"

    def __init__(self) -> None:
        super().__init__()
        self.entered = Event()

    def translate_document(self, blocks, target_language, *, cancellation, **_kwargs):
        self.entered.set()
        deadline = monotonic() + 3
        while monotonic() < deadline:
            if cancellation():
                raise DocumentTranslationError(
                    "canceled", "整篇翻译已取消", retryable=True
                )
            sleep(0.01)
        raise AssertionError("translation cancellation did not arrive")


class _BlockingProvider(_FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.entered = Event()
        self.release = Event()

    def translate_document(self, blocks, target_language, **kwargs):
        self.entered.set()
        assert self.release.wait(3), "blocked translation was not released"
        return super().translate_document(blocks, target_language, **kwargs)


class _CheckpointProvider(_FakeProvider):
    capacity = TranslationCapacity(max_input_characters=160, max_output_tokens=20_000)

    def __init__(self) -> None:
        super().__init__()
        self.failed_once = False

    def translate_document(self, blocks, target_language, **kwargs):
        if len(self.calls) == 1 and not self.failed_once:
            self.calls.append(list(blocks))
            self.failed_once = True
            raise DocumentTranslationError(
                "provider_unavailable", "temporary provider failure", retryable=True
            )
        return super().translate_document(blocks, target_language, **kwargs)


def _wait_for_job(client, job_id: str) -> dict:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed", "canceled"}:
            return job
        sleep(0.02)
    raise AssertionError(f"job did not finish: {job_id}")


def test_document_job_prefers_sibling_tex_structure_over_pdf_segmentation(client) -> None:
    context = client.app.state.context
    work = context.catalog_commands.create_work(
        BibliographicItemDraft(title="TeX-priority semantic document", language="en")
    )
    item_id = work.items[0].id
    tex = r"""
    \documentclass{article}
    \title{Whole-document translation}
    \begin{document}
    \maketitle
    \section{Method}
    The method preserves every stable block identifier, cites [1], keeps $x_i$, and links https://example.org.
    \begin{equation}E = mc^2\end{equation}
    \end{document}
    """
    source_archive = BytesIO()
    with zipfile.ZipFile(source_archive, "w") as archive:
        archive.writestr("main.tex", tex)
    source = client.post(
        f"/api/items/{item_id}/attachments",
        files={
            "upload": (
                "source.zip",
                source_archive.getvalue(),
                "application/zip",
            )
        },
        data={"attachment_type": "source_archive", "preferred_for": "structure"},
    )
    assert source.status_code == 201, source.text
    assert source.json()["format"] == "tex"
    pdf = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )
    assert pdf.status_code == 201, pdf.text
    context.documents.extractor = _FakeExtractor()
    context.documents.tex_extractor = TexStructureExtractor()

    launched = client.post(
        f"/api/attachments/{pdf.json()['id']}/documents", json={"ocr_mode": "auto"}
    )
    assert launched.status_code == 202, launched.text
    completed = _wait_for_job(client, launched.json()["id"])
    assert completed["status"] == "succeeded", completed

    internal = context.job_repository.get(launched.json()["id"])
    assert internal.input["tex_attachment_id"] == source.json()["id"]
    document = client.get(f"/api/items/{item_id}/documents").json()[0]
    assert document["extractor"] == "fake-layout+tex-structure"
    blocks = client.get(f"/api/documents/{document['id']}/blocks").json()["items"]
    assert [block["kind"] for block in blocks] == [
        "title",
        "heading",
        "paragraph",
        "formula",
    ]
    assert blocks[1]["section_path"] == ["Method"]
    assert blocks[2]["page_start"] == 1
    events = context.job_repository.list_events(launched.json()["id"])
    assert any(event.event_type == "document.tex_structure_applied" for event in events)


def test_document_jobs_are_atomic_idempotent_and_translate_in_one_request(client) -> None:
    context = client.app.state.context
    work = context.catalog_commands.create_work(
        BibliographicItemDraft(title="Semantic document fixture", language="en")
    )
    item_id = work.items[0].id
    upload = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )
    assert upload.status_code == 201, upload.text
    attachment_id = upload.json()["id"]
    extractor = _FakeExtractor()
    provider = _FakeProvider()
    context.documents.extractor = extractor
    context.documents.translation_provider = provider

    launched = client.post(
        f"/api/attachments/{attachment_id}/documents", json={"ocr_mode": "auto"}
    )
    assert launched.status_code == 202, launched.text
    extraction_job = launched.json()
    assert _wait_for_job(client, extraction_job["id"])["status"] == "succeeded"
    repeated = client.post(
        f"/api/attachments/{attachment_id}/documents", json={"ocr_mode": "auto"}
    ).json()
    assert repeated["id"] == extraction_job["id"]
    assert extractor.calls == 1

    documents = client.get(f"/api/items/{item_id}/documents").json()
    assert len(documents) == 1
    document = documents[0]
    assert document["status"] == "ready"
    assert document["block_count"] == 3
    blocks = client.get(f"/api/documents/{document['id']}/blocks").json()
    assert [item["kind"] for item in blocks["items"]] == [
        "title",
        "paragraph",
        "formula",
    ]

    launched_translation = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    )
    assert launched_translation.status_code == 202, launched_translation.text
    translation_job = launched_translation.json()
    assert _wait_for_job(client, translation_job["id"])["status"] == "succeeded"
    repeated_translation = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()
    assert repeated_translation["id"] == translation_job["id"]
    assert len(provider.calls) == 1
    assert len(provider.calls[0]) == 2

    translated = client.get(
        f"/api/documents/{document['id']}/blocks",
        params={"target_language": "zh-CN"},
    ).json()["items"]
    assert translated[0]["translation"]["translated_text"].startswith("zh-CN：")
    assert translated[1]["semantic_role"] == "method"
    assert "[1]" in translated[1]["translation"]["translated_text"]
    assert "$x_i$" in translated[1]["translation"]["translated_text"]
    assert "https://example.org" in translated[1]["translation"]["translated_text"]
    assert translated[2]["translation"] is None
    with context.database.read() as connection:
        actions = {
            row["action"]
            for row in connection.execute(
                "SELECT action FROM audit_events WHERE entity_id = ?", (document["id"],)
            )
        }
        glossary_count = connection.execute(
            "SELECT COUNT(*) FROM document_glossary_entries WHERE document_id = ?",
            (document["id"],),
        ).fetchone()[0]
    assert {"document.extracted", "document.translated"} <= actions
    assert glossary_count == 1

    current_preferences = client.get("/api/user-preferences").json()
    full_retranslation_preferences = {
        key: value
        for key, value in current_preferences.items()
        if key not in {"revision", "updated_at"}
    }
    full_retranslation_preferences["expected_revision"] = current_preferences["revision"]
    full_retranslation_preferences["translation"] = {
        **current_preferences["translation"],
        "retranslate_scope": "document",
    }
    saved_preferences = client.put(
        "/api/user-preferences", json=full_retranslation_preferences
    )
    assert saved_preferences.status_code == 200, saved_preferences.text

    forced_provider = _BlockingProvider()
    context.documents.translation_provider = forced_provider
    forced = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()
    assert forced["id"] != translation_job["id"]
    assert forced_provider.entered.wait(2)
    concurrent_repeat = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()
    assert concurrent_repeat["id"] == forced["id"]
    forced_provider.release.set()
    assert _wait_for_job(client, forced["id"])["status"] == "succeeded"
    assert len(forced_provider.calls) == 1

    forced_again = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()
    assert forced_again["id"] not in {translation_job["id"], forced["id"]}
    assert _wait_for_job(client, forced_again["id"])["status"] == "succeeded"
    assert len(forced_provider.calls) == 2

    forced_provider.invalid = True
    invalid = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-TW"},
    ).json()
    failed = _wait_for_job(client, invalid["id"])
    assert failed["status"] == "failed"
    assert failed["error_code"] == "invalid_translation_output"
    untranslated = client.get(
        f"/api/documents/{document['id']}/blocks",
        params={"target_language": "zh-TW"},
    ).json()["items"]
    assert all(item["translation"] is None for item in untranslated)


def test_chapter_fallback_reuses_verified_checkpoints_after_retry(client) -> None:
    context = client.app.state.context
    work = context.catalog_commands.create_work(
        BibliographicItemDraft(title="Translation checkpoint fixture", language="en")
    )
    item_id = work.items[0].id
    upload = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("checkpoint.pdf", PDF, "application/pdf")},
    )
    attachment_id = upload.json()["id"]
    context.documents.extractor = _FakeExtractor()
    provider = _CheckpointProvider()
    context.documents.translation_provider = provider

    extraction = client.post(
        f"/api/attachments/{attachment_id}/documents", json={"ocr_mode": "auto"}
    ).json()
    assert _wait_for_job(client, extraction["id"])["status"] == "succeeded"
    document = client.get(f"/api/items/{item_id}/documents").json()[0]
    translation = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()

    completed = _wait_for_job(client, translation["id"])
    assert completed["status"] == "succeeded", completed
    assert len(provider.calls) == 3
    with context.database.read() as connection:
        checkpoints = connection.execute(
            "SELECT COUNT(*) FROM translation_batch_checkpoints WHERE job_id = ?",
            (translation["id"],),
        ).fetchone()[0]
    assert checkpoints == 2
    events = context.job_repository.list_events(translation["id"])
    assert any(event.event_type == "document.translation_batch_reused" for event in events)


def test_document_extraction_and_translation_cancel_without_partial_records(client) -> None:
    context = client.app.state.context
    work = context.catalog_commands.create_work(
        BibliographicItemDraft(title="Cancelable semantic document", language="en")
    )
    item_id = work.items[0].id
    upload = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("cancel.pdf", PDF, "application/pdf")},
    )
    attachment_id = upload.json()["id"]

    cancelable_extractor = _CancelableExtractor()
    context.documents.extractor = cancelable_extractor
    extraction_job = client.post(
        f"/api/attachments/{attachment_id}/documents", json={"ocr_mode": "auto"}
    ).json()
    assert cancelable_extractor.entered.wait(2)
    assert client.post(f"/api/jobs/{extraction_job['id']}/cancel").status_code == 202
    assert _wait_for_job(client, extraction_job["id"])["status"] == "canceled"
    assert client.get(f"/api/items/{item_id}/documents").json() == []

    context.documents.extractor = _FakeExtractor()
    completed_extraction = client.post(
        f"/api/attachments/{attachment_id}/documents", json={"ocr_mode": "auto"}
    ).json()
    assert _wait_for_job(client, completed_extraction["id"])["status"] == "succeeded"
    document = client.get(f"/api/items/{item_id}/documents").json()[0]

    cancelable_provider = _CancelableProvider()
    context.documents.translation_provider = cancelable_provider
    translation_job = client.post(
        f"/api/documents/{document['id']}/translate",
        json={"target_language": "zh-CN"},
    ).json()
    assert cancelable_provider.entered.wait(2)
    assert client.post(f"/api/jobs/{translation_job['id']}/cancel").status_code == 202
    assert _wait_for_job(client, translation_job["id"])["status"] == "canceled"
    blocks = client.get(
        f"/api/documents/{document['id']}/blocks",
        params={"target_language": "zh-CN"},
    ).json()["items"]
    assert all(block["translation"] is None for block in blocks)


def test_document_commits_are_reconciled_after_worker_restart(client) -> None:
    context = client.app.state.context
    context.job_worker.stop()
    work = context.catalog_commands.create_work(
        BibliographicItemDraft(title="Restart reconciliation", language="en")
    )
    item_id = work.items[0].id
    upload = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("restart.pdf", PDF, "application/pdf")},
    )
    attachment_id = upload.json()["id"]
    attachment, _ = context.attachments.locate(attachment_id)

    extraction_job = context.job_repository.enqueue(
        JobCreate(
            kind="document.extract",
            input={"attachment_id": attachment_id},
            subject_type="attachment",
            subject_id=attachment_id,
        )
    )
    claimed_extraction = context.job_repository.claim_next("dead-extraction-worker")
    assert claimed_extraction is not None
    extracted = ExtractedDocument(
        language="en",
        page_count=1,
        blocks=[
            ExtractedBlock(
                kind=BlockKind.PARAGRAPH,
                source_text="A durable structured paragraph.",
                page_start=1,
                page_end=1,
                anchor={"page": 1, "bbox": _box(20, 40, 300, 70)},
            )
        ],
    )
    structure_hash = "a" * 64
    document = context.documents.repository.commit_extraction(
        item_id=item_id,
        source_attachment_id=attachment_id,
        source_sha256=attachment.sha256,
        extractor="restart-layout",
        extractor_version="1.0",
        structure_version="restart-v1",
        structure_hash=structure_hash,
        extracted=extracted,
        job_id=extraction_job.id,
    )
    assert context.job_repository.get(extraction_job.id).status is JobStatus.RUNNING
    assert context.documents.reconcile_committed() == 1
    assert context.job_repository.get(extraction_job.id).status is JobStatus.SUCCEEDED

    translation_job = context.job_repository.enqueue(
        JobCreate(
            kind="document.translate",
            input={"document_id": document.id, "target_language": "zh-CN"},
            subject_type="document",
            subject_id=document.id,
        )
    )
    claimed_translation = context.job_repository.claim_next("dead-translation-worker")
    assert claimed_translation is not None
    block = context.documents.repository.all_blocks(document.id)[0]
    context.documents.repository.commit_translation(
        document_id=document.id,
        expected_structure_hash=structure_hash,
        target_language="zh-CN",
        provider="restart-provider",
        model="restart-model",
        prompt_version="restart-prompt",
        output=DocumentTranslationOutput(
            translations=[
                TranslationOutputItem(
                    id=block.id,
                    translated_text="一个可恢复的结构化段落。",
                    semantic_role=SemanticRole.EVIDENCE,
                )
            ]
        ),
        job_id=translation_job.id,
    )
    assert context.job_repository.get(translation_job.id).status is JobStatus.RUNNING
    assert context.documents.reconcile_committed() == 1
    recovered = context.job_repository.get(translation_job.id)
    assert recovered.status is JobStatus.SUCCEEDED
    assert recovered.result == {
        "document_id": document.id,
        "target_language": "zh-CN",
        "translated_blocks": 1,
    }
