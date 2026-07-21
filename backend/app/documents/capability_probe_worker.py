from __future__ import annotations

import argparse
import inspect
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

PDF2ZH_VERSION = "2.9.0"
BABELDOC_VERSION = "0.6.2"
RAPIDOCR_VERSION = "3.9.2"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()

    installed = {
        name: _version(name)
        for name in ("pdf2zh-next", "babeldoc", "rapidocr")
    }
    typed_high_level_api = False
    translator_extension = False
    try:
        from babeldoc.format.pdf.high_level import async_translate
        from babeldoc.format.pdf.translation_config import TranslationConfig
        from babeldoc.translator.translator import BaseTranslator

        async_parameters = inspect.signature(async_translate).parameters
        config_parameters = inspect.signature(TranslationConfig).parameters
        translator_parameters = inspect.signature(BaseTranslator.do_translate).parameters
        typed_high_level_api = (
            "translation_config" in async_parameters
            and {"translator", "input_file", "doc_layout_model", "skip_translation"}
            <= set(config_parameters)
        )
        translator_extension = set(translator_parameters) == {
            "self",
            "text",
            "rate_limit_params",
        }
    except (ImportError, TypeError, ValueError):
        pass

    compatible = (
        installed["pdf2zh-next"] == PDF2ZH_VERSION
        and installed["babeldoc"] == BABELDOC_VERSION
        and installed["rapidocr"] == RAPIDOCR_VERSION
        and typed_high_level_api
        and translator_extension
    )
    payload = {
        "schema_version": 1,
        "compatible": compatible,
        "pdf2zh_version": installed["pdf2zh-next"],
        "babeldoc_version": installed["babeldoc"],
        "rapidocr_version": installed["rapidocr"],
        "typed_high_level_api": typed_high_level_api,
        "translator_extension": translator_extension,
        "page_coordinates": compatible,
        "reading_order": compatible,
        "paragraph_boundaries": compatible,
        "block_classification": compatible,
        # The layout model exposes labels, but the fixed-version fixture probe does
        # not classify every table, figure, formula, or footnote consistently.
        "specialized_block_types": False,
        "true_ocr": compatible,
        "ocr_confidence": compatible,
        # The fixed API passes only paragraph text to translators. It has no stable
        # block identifier or verified external-translation callback, so claiming
        # deterministic reinjection would be unsafe.
        "external_block_translation_injection": False,
        "translated_pdf_from_external_blocks": False,
        "message": (
            "版面结构、段落、阅读顺序与 RapidOCR 可复用；特殊块类型和外部译文回注不可靠"
            if compatible
            else "受管理依赖版本或公开扩展点与适配器契约不一致"
        ),
    }
    arguments.output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def _version(distribution: str) -> str | None:
    try:
        return version(distribution)
    except PackageNotFoundError:
        return None


if __name__ == "__main__":
    main()
