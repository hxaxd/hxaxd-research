from __future__ import annotations

import hashlib
import json
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class Config:
    workspace: Path
    parse: dict[str, Any] = field(default_factory=dict)
    translate: dict[str, Any] = field(default_factory=dict)
    render: dict[str, Any] = field(default_factory=dict)

    def digest(self, section: str) -> str:
        data = getattr(self, section)
        encoded = json.dumps(data, sort_keys=True, ensure_ascii=True).encode()
        return hashlib.sha256(encoded).hexdigest()


def load_config(start: Path | None = None) -> Config:
    root = (start or Path.cwd()).resolve()
    config_path = root / "config.toml"
    data: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("rb") as handle:
            data = tomllib.load(handle)

    workspace_value = "./workspace"
    workspace = Path(workspace_value)
    if not workspace.is_absolute():
        workspace = root / workspace

    parse_data = data.get("parse", {})
    translate_data = data.get("translate", {})
    return Config(
        workspace=workspace.resolve(),
        parse={
            "device": parse_data.get("device", "gpu"),
            "text_detection_model": "PP-OCRv6_medium_det",
            "text_recognition_model": "PP-OCRv6_medium_rec",
        },
        translate={
            "base_url": translate_data.get(
                "base_url", "https://api.openai.com/v1"
            ),
            "model": translate_data.get("model", "gpt-4.1-mini"),
            "api_key_env": translate_data.get(
                "api_key_env", "OPENAI_API_KEY"
            ),
            "block_chars": 6000,
        },
        render={"browser": "chromium"},
    )
