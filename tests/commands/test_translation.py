"""Run with the project's translation Python environment."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / "src/features/translation/pipeline.py"


class TranslationCommands(unittest.TestCase):
    def setUp(self):
        test_root = ROOT / ".runtime/dev"
        test_root.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"katex": str(ROOT / "node_modules/katex/dist")}), encoding="utf-8")
        self.document = self.root / "document.json"
        self.blocks = [{"id": f"b{index}", "page": 1, "label": "text", "text": f"Paragraph {index}.",
                        "preserve": False, "bbox": [0, index, 100, index + 1]}
                       for index in range(100)]
        self.blocks[0].update(label="formula", text="E=mc^2", preserve=True)
        self.document.write_text(json.dumps({"title": "A document", "source": "source.pdf",
                                            "pages": [{"blocks": self.blocks}]}), encoding="utf-8")

    def command(self, *args):
        return subprocess.run([sys.executable, "-X", "utf8", str(PIPELINE), "--config", str(self.config),
                               *map(str, args)], capture_output=True, text=True, encoding="utf-8")

    def test_prepare_exposes_the_complete_document_for_translation(self):
        output = self.root / "request.json"
        result = self.command("prepare", "--document", self.document, "--output", output, "--target", "zh-CN")
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads(output.read_text(encoding="utf-8"))
        payload = json.loads(request["prompt"])
        self.assertEqual([block["id"] for block in payload["blocks"]], [block["id"] for block in self.blocks])

    def test_render_accepts_complete_translations_and_reports_missing_duplicate_or_changed_formula(self):
        translated = [{"id": block["id"], "text": block["text"] if block["preserve"] else "译文"}
                      for block in self.blocks]
        source = self.root / "translations.json"
        output = self.root / "reading"
        for items in [translated, translated[:-1], translated + [translated[0]],
                      [{"id": "b0", "text": "changed"}] + translated[1:]]:
            source.write_text(json.dumps({"blocks": items}), encoding="utf-8")
            result = self.command("render", "--document", self.document, "--translations", source,
                                  "--output", output, "--target", "zh-CN")
            if items is translated:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("译文", (output / "translated.html").read_text(encoding="utf-8"))
                self.assertIn("E=mc^2", (output / "translated.md").read_text(encoding="utf-8"))
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr.strip())


if __name__ == "__main__":
    unittest.main()
