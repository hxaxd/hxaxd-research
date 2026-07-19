from __future__ import annotations

import json

import pytest

from scripts.submit_papers import read_jsonl


def test_read_jsonl_keeps_one_complete_object_per_line(tmp_path):
    path = tmp_path / "papers.jsonl"
    records = [{"stable_key": "one"}, {"stable_key": "two"}]
    path.write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in records),
        encoding="utf-8",
    )
    assert read_jsonl(path) == records


def test_read_jsonl_reports_the_invalid_line(tmp_path):
    path = tmp_path / "papers.jsonl"
    path.write_text('{"stable_key": "one"}\nnot-json\n', encoding="utf-8")
    with pytest.raises(ValueError, match="line 2"):
        read_jsonl(path)
