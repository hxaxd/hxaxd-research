from __future__ import annotations

from io import BytesIO

from pypdf import PdfWriter


def _pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


PDF = _pdf()
