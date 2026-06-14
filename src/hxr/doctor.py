from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path

from .config import Config


@dataclass(frozen=True, slots=True)
class Check:
    name: str
    status: str
    detail: str


def _module_check(module: str, label: str) -> Check:
    available = importlib.util.find_spec(module) is not None
    return Check(
        label,
        "ok" if available else "missing",
        f"Python module `{module}` is {'available' if available else 'missing'}.",
    )


def run_doctor(config: Config) -> list[Check]:
    checks: list[Check] = []
    workspace = config.workspace
    try:
        workspace.mkdir(parents=True, exist_ok=True)
        probe = workspace / ".hxr-doctor-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        checks.append(Check("workspace", "ok", f"Writable: {workspace}"))
    except OSError as exc:
        checks.append(Check("workspace", "error", str(exc)))

    key_env = str(config.translate.get("api_key_env", "OPENAI_API_KEY"))
    checks.append(
        Check(
            "translation key",
            "ok" if os.getenv(key_env) else "missing",
            f"Environment variable `{key_env}` is "
            f"{'set' if os.getenv(key_env) else 'not set'}.",
        )
    )
    checks.extend(
        [
            _module_check("paddle", "PaddlePaddle"),
            _module_check("paddleocr", "PaddleOCR"),
            _module_check("playwright", "Playwright"),
        ]
    )

    if importlib.util.find_spec("paddle") is not None:
        try:
            import paddle

            configured = str(config.parse.get("device", "gpu"))
            available = str(paddle.device.get_device())
            status = "ok" if configured.split(":")[0] in available else "warning"
            checks.append(
                Check(
                    "parse device",
                    status,
                    f"Configured `{configured}`, Paddle reports `{available}`.",
                )
            )
        except Exception as exc:
            checks.append(Check("parse device", "error", str(exc)))

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            executable = Path(
                getattr(
                    playwright,
                    str(config.render.get("browser", "chromium")),
                ).executable_path
            )
        checks.append(
            Check(
                "browser",
                "ok" if executable.is_file() else "missing",
                f"Browser executable: {executable}",
            )
        )
    except Exception as exc:
        checks.append(Check("browser", "missing", str(exc)))
    return checks


def doctor_exit_code(checks: list[Check]) -> int:
    return 0 if all(check.status in {"ok", "warning"} for check in checks) else 1
