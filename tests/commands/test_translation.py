"""Run with the project's translation Python environment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / "src/app/translation/pipeline.py"
MODEL_COMMAND = ROOT / "tests/support/translation-model.py"


class TranslationCommands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        test_root = ROOT / ".runtime/dev"
        test_root.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=test_root)
        cls.addClassCleanup(directory.cleanup)
        cls.runtime = Path(directory.name)
        cls.templates = cls.runtime / "templates"
        cls.app_config = cls.runtime / "app.jsonc"
        cls.app_config.write_text(json.dumps({"templateDir": str(cls.templates)}), encoding="utf-8")
        cls.env = {**os.environ, "APP_CONFIG_FILE": str(cls.app_config)}
        subprocess.run(["node", str(ROOT / "src/app/install.mjs")], env=cls.env, check=True, capture_output=True)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.runtime)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = self.root / "config.json"
        self.config.write_text("{}", encoding="utf-8")
        self.document = self.root / "document.json"
        self.blocks = [{"id": f"b{index}", "page": 1, "label": "text", "text": f"Paragraph {index}.",
                        "preserve": False, "bbox": [0, index, 100, index + 1]}
                       for index in range(100)]
        self.blocks[0].update(label="formula", text="E=mc^2", preserve=True)
        self.document.write_text(json.dumps({"title": "A document", "source": "source.pdf",
                                            "pages": [{"blocks": self.blocks}]}), encoding="utf-8")

    def command(self, *args):
        return subprocess.run([sys.executable, "-X", "utf8", str(PIPELINE), "--config", str(self.config),
                               *map(str, args)], env=self.env, capture_output=True, text=True, encoding="utf-8")

    def test_prepare_exposes_the_complete_document_for_translation(self):
        output = self.root / "request.json"
        result = self.command("prepare", "--document", self.document, "--output", output, "--target", "zh-CN")
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads(output.read_text(encoding="utf-8"))
        payload = json.loads(request["prompt"])
        self.assertEqual(payload, {
            "title": "A document", "target": "zh-CN", "instructions": "", "glossary": "",
            "blocks": [{"id": "b0", "label": "formula", "text": "E=mc^2", "preserve": True}] + [
                {"id": f"b{index}", "label": "text", "text": f"Paragraph {index}.", "preserve": False}
                for index in range(1, 100)
            ],
        })

    def test_translate_batches_a_document_and_writes_all_translations_in_order(self):
        self.config.write_text(json.dumps({"modelsCommand": [sys.executable, str(MODEL_COMMAND)]}), encoding="utf-8")
        output = self.root / "translated"
        result = self.command("translate", "--document", self.document, "--output", output,
                              "--target", "zh-CN", "--model", "test/translator")
        self.assertEqual(result.returncode, 0, result.stderr)
        progress = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertGreater(len(progress), 1)
        self.assertEqual(sum(batch["blocks"] for batch in progress), 100)
        self.assertEqual(json.loads((output / "translations.json").read_text(encoding="utf-8"))["blocks"], [
            {"id": "b0", "text": "E=mc^2"}, *[
                {"id": f"b{index}", "text": f"译文：Paragraph {index}."} for index in range(1, 100)
            ],
        ])

    def test_failed_rerun_preserves_previous_output_but_render_rejects_it_for_changed_source(self):
        self.config.write_text(json.dumps({"modelsCommand": [sys.executable, str(MODEL_COMMAND)]}), encoding="utf-8")
        output = self.root / "translated"
        command = ("translate", "--document", self.document, "--output", output, "--target", "zh-CN", "--model")
        first = self.command(*command, "test/translator")
        self.assertEqual(first.returncode, 0, first.stderr)
        final = output / "translations.json"
        original = final.read_bytes()
        wrong_language = self.command("render", "--document", self.document, "--translations", final,
                                      "--output", self.root / "wrong-language", "--target", "en")
        self.assertEqual(wrong_language.returncode, 1)
        self.assertIn("译文与当前原文或目标语言不匹配", wrong_language.stderr)

        document = json.loads(self.document.read_text(encoding="utf-8"))
        document["pages"][0]["blocks"][1]["text"] = "A revised paragraph."
        self.document.write_text(json.dumps(document), encoding="utf-8")
        rerun = self.command(*command, "test/unavailable")
        self.assertNotEqual(rerun.returncode, 0)
        self.assertFalse(final.exists())
        [partial] = output.glob("run-*/partial-translations.json")
        self.assertEqual(json.loads(partial.read_text(encoding="utf-8"))["blocks"], [])
        [previous] = output.glob("previous-*/translations.json")
        self.assertEqual(previous.read_bytes(), original)

        rendered = self.command("render", "--document", self.document, "--translations", previous,
                                "--output", self.root / "rendered", "--target", "zh-CN")
        self.assertEqual(rendered.returncode, 1)
        self.assertIn("译文与当前原文或目标语言不匹配", rendered.stderr)

    def test_commands_use_the_configured_runtime_prompt_and_html_template(self):
        templates = self.root / "templates"
        prompt = templates / "app/translation/prompts/blocks.md"
        prompt.parent.mkdir(parents=True)
        prompt.write_text("Custom translation instructions: {{target}}", encoding="utf-8")
        template = templates / "app/translation/skills/paper-translation/assets/paper.html"
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
        templates = self.root / "templates"
        template = templates / "app/translation/skills/paper-translation/assets/paper.html"
        template.parent.mkdir(parents=True)
        template.write_text("<html><body data-template='workspace'>{{CONTENT}}</body></html>", encoding="utf-8")
        config.write_text(json.dumps({"templateDir": str(templates)}), encoding="utf-8")
        source = self.root / "source.md"
        source.write_text("# 标题\n\n中文译稿。", encoding="utf-8")
        output = self.root / "rendered.html"
        result = subprocess.run([sys.executable, "-X", "utf8", str(PIPELINE), "render-markdown",
                                 "--input", str(source), "--output", str(output), "--target", "zh-CN"],
                                cwd=self.root, env={**self.env, "APP_CONFIG_FILE": str(config)},
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        html = output.read_text(encoding="utf-8")
        self.assertIn("data-template='workspace'", html)
        self.assertIn("中文译稿", html)

    def test_render_accepts_complete_translations_and_reports_missing_duplicate_or_changed_formula(self):
        translated = [{"id": block["id"], "text": block["text"] if block["preserve"] else "译文"}
                      for block in self.blocks]
        source = self.root / "translations.json"
        source.write_text(json.dumps({"blocks": translated}), encoding="utf-8")
        output = self.root / "reading"
        result = self.command("render", "--document", self.document, "--translations", source,
                              "--output", output, "--target", "zh-CN")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("译文", (output / "translated.html").read_text(encoding="utf-8"))
        self.assertIn("E=mc^2", (output / "translated.md").read_text(encoding="utf-8"))
        for case, items, error in [
            ("missing", translated[:-1], "缺少 ['b99']"),
            ("duplicate", translated + [translated[0]], "译块 ID 不完整"),
            ("formula", [{"id": "b0", "text": "changed"}] + translated[1:], "保留块 b0 被修改"),
        ]:
            with self.subTest(case=case):
                source.write_text(json.dumps({"blocks": items}), encoding="utf-8")
                output = self.root / case
                result = self.command("render", "--document", self.document, "--translations", source,
                                      "--output", output, "--target", "zh-CN")
                self.assertEqual(result.returncode, 1)
                self.assertIn(error, result.stderr)
                self.assertFalse((output / "translated.html").exists())


if __name__ == "__main__":
    unittest.main()
