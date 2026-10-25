"""Run with the project's translation Python environment."""
import json
import os
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

    def test_commands_use_the_configured_runtime_prompt_and_html_template(self):
        templates = self.root / "templates"
        prompt = templates / "features/translation/prompts/blocks.md"
        prompt.parent.mkdir(parents=True)
        prompt.write_text("Custom translation instructions: {{target}}", encoding="utf-8")
        template = templates / "features/translation/skills/paper-translation/assets/paper.html"
        template.parent.mkdir(parents=True)
        template.write_text("<html><body data-template='custom'>{{CONTENT}}</body></html>", encoding="utf-8")
        self.config.write_text(json.dumps({"templateDir": str(templates)}), encoding="utf-8")
        request = self.root / "request.json"
        prepared = self.command("prepare", "--document", self.document, "--output", request, "--target", "zh-CN")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads(request.read_text(encoding="utf-8"))["system"], "Custom translation instructions: zh-CN")
        source = self.root / "source.md"
        source.write_text("# Runtime template", encoding="utf-8")
        output = self.root / "reading.html"
        rendered = self.command("render-markdown", "--input", source, "--output", output, "--target", "zh-CN")
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        self.assertIn("data-template='custom'", output.read_text(encoding="utf-8"))

    def test_render_markdown_uses_application_configuration_from_a_workspace_directory(self):
        config = self.root / "app-config.json"
        config.write_text(json.dumps({"envDir": str(self.root / "env")}), encoding="utf-8")
        source = self.root / "source.md"
        source.write_text("# 标题\n\n中文译稿。", encoding="utf-8")
        output = self.root / "rendered.html"
        result = subprocess.run([sys.executable, "-X", "utf8", str(PIPELINE), "render-markdown",
                                 "--input", str(source), "--output", str(output), "--target", "zh-CN"],
                                cwd=self.root, env={**os.environ, "APP_CONFIG_FILE": str(config)},
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("中文译稿", output.read_text(encoding="utf-8"))

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
