from __future__ import annotations

import argparse
import json
from importlib.metadata import version
from pathlib import Path

import fitz
import numpy as np
from rapidocr import RapidOCR


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=200)
    arguments = parser.parse_args()

    engine = RapidOCR()
    pages: list[dict[str, object]] = []
    with fitz.open(arguments.source) as document:
        for page_index, page in enumerate(document):
            matrix = fitz.Matrix(arguments.dpi / 72, arguments.dpi / 72)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False, colorspace=fitz.csRGB)
            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            result = engine(image)
            boxes = result.boxes.tolist() if result.boxes is not None else []
            texts = list(result.txts) if result.txts is not None else []
            scores = (
                [float(score) for score in result.scores]
                if result.scores is not None
                else []
            )
            if not (len(boxes) == len(texts) == len(scores)):
                raise RuntimeError("RapidOCR returned inconsistent line arrays")
            lines = [
                {"text": text, "confidence": score, "points": points}
                for points, text, score in zip(boxes, texts, scores, strict=True)
                if isinstance(text, str) and text.strip()
            ]
            pages.append(
                {
                    "page_number": page_index + 1,
                    "pdf_width": float(page.rect.width),
                    "pdf_height": float(page.rect.height),
                    "image_width": pixmap.width,
                    "image_height": pixmap.height,
                    "lines": lines,
                }
            )
    payload = {
        "engine": "rapidocr",
        "version": version("rapidocr"),
        "dpi": arguments.dpi,
        "pages": pages,
    }
    arguments.output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
