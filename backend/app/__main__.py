from __future__ import annotations

import argparse
import ipaddress
import shutil
import socket
import subprocess
from dataclasses import replace
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI

from app.core.config import REPOSITORY_ROOT, Settings
from app.main import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="启动本地文献工作台")
    subcommands = parser.add_subparsers(dest="command", required=True)
    serve = subcommands.add_parser("serve", help="构建前端并启动工作台")
    serve.add_argument("--lan", action="store_true", help="显式允许局域网设备配对访问")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--public-url", help="平板打开的工作台地址")
    serve.add_argument("--agent-url", help="本机智能体访问工作台工具的地址")
    serve.add_argument("--ssl-certfile", help="受信任的 HTTPS 证书文件")
    serve.add_argument("--ssl-keyfile", help="HTTPS 证书私钥文件")
    serve.add_argument(
        "--allow-insecure-http",
        action="store_true",
        help="仅调试：允许未加密的局域网访问（平板 PWA 与安全 Cookie 不可用）",
    )
    serve.add_argument("--skip-build", action="store_true", help="复用已有前端构建")
    arguments = parser.parse_args()
    if arguments.command == "serve":
        _serve(arguments)


def _serve(arguments: argparse.Namespace) -> None:
    port = int(arguments.port)
    if port < 1 or port > 65535:
        raise SystemExit("端口必须在 1 到 65535 之间")
    if not arguments.skip_build:
        _build_frontend()
    distribution = REPOSITORY_ROOT / "frontend" / "dist" / "index.html"
    if not distribution.is_file():
        raise SystemExit("前端尚未构建；请移除 --skip-build 或先在 frontend 运行 npm run build")

    settings = Settings.from_environment()
    certificate, private_key = _tls_files(arguments)
    secure = certificate is not None
    bind_host = "127.0.0.1"
    scheme = "https" if secure else "http"
    public_url = f"{scheme}://127.0.0.1:{port}"
    if arguments.lan:
        if not secure and not arguments.allow_insecure_http:
            raise SystemExit(
                "局域网模式要求 --ssl-certfile 与 --ssl-keyfile；"
                "仅临时调试可以显式使用 --allow-insecure-http"
            )
        bind_host = "0.0.0.0"
        public_url = arguments.public_url or f"{scheme}://{_discover_lan_address()}:{port}"
        parsed = urlsplit(public_url)
        effective_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if (
            parsed.scheme != scheme
            or not parsed.hostname
            or effective_port != port
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise SystemExit(f"--public-url 必须是当前端口的纯 {scheme} 地址")
        if _is_loopback(parsed.hostname):
            raise SystemExit("局域网模式的 --public-url 不能使用回环地址")
    public_host = urlsplit(public_url).hostname or "127.0.0.1"
    agent_socket = (
        _reserve_loopback_socket() if secure and arguments.agent_url is None else None
    )
    agent_url = _resolve_agent_url(
        arguments.agent_url,
        scheme=scheme,
        port=port,
        internal_port=(int(agent_socket.getsockname()[1]) if agent_socket else None),
    )
    settings = replace(
        settings,
        public_base_url=public_url,
        agent_base_url=agent_url.rstrip("/"),
        lan_access_enabled=bool(arguments.lan),
        device_cookie_secure=secure,
        allowed_hosts=tuple(
            dict.fromkeys((*settings.allowed_hosts, public_host, "127.0.0.1", "localhost"))
        ),
    )
    print(f"本机工作台： {scheme}://127.0.0.1:{port}")
    if arguments.lan:
        print(f"平板工作台： {public_url}")
        if secure:
            print("请确认电脑与平板都信任此证书，再在本机设置页生成一次性配对码。")
        else:
            print("警告：当前为未加密调试模式，安全 Cookie 与平板 PWA 不可用。")
    internal_server: uvicorn.Server | None = None
    internal_thread: Thread | None = None
    try:
        application = create_app(settings)
        if agent_socket is not None:
            internal_server, internal_thread = _start_internal_agent_listener(
                application, agent_socket
            )
        uvicorn.run(
            application,
            host=bind_host,
            port=port,
            ssl_certfile=str(certificate) if certificate else None,
            ssl_keyfile=str(private_key) if private_key else None,
        )
    finally:
        if internal_server is not None and internal_thread is not None:
            internal_server.should_exit = True
            internal_thread.join(timeout=5)
            if internal_thread.is_alive():
                internal_server.force_exit = True
                internal_thread.join(timeout=5)
        if agent_socket is not None:
            agent_socket.close()


def _tls_files(arguments: argparse.Namespace) -> tuple[Path | None, Path | None]:
    if bool(arguments.ssl_certfile) != bool(arguments.ssl_keyfile):
        raise SystemExit("--ssl-certfile 与 --ssl-keyfile 必须同时提供")
    if not arguments.ssl_certfile:
        return None, None
    certificate = Path(arguments.ssl_certfile).resolve()
    private_key = Path(arguments.ssl_keyfile).resolve()
    if not certificate.is_file() or not private_key.is_file():
        raise SystemExit("HTTPS 证书或私钥文件不存在")
    return certificate, private_key


def _validate_agent_url(value: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("--agent-url 必须是纯 http 或 https 地址")
    if not _is_loopback(parsed.hostname):
        raise SystemExit("--agent-url 必须使用本机回环地址，不能暴露智能体工具端点")


def _resolve_agent_url(
    value: str | None,
    *,
    scheme: str,
    port: int,
    internal_port: int | None = None,
) -> str:
    if value is not None:
        resolved = value
    elif scheme == "https":
        if internal_port is None:
            raise ValueError("secure serving requires a reserved internal agent listener")
        resolved = f"http://127.0.0.1:{internal_port}"
    else:
        resolved = f"http://127.0.0.1:{port}"
    _validate_agent_url(resolved)
    return resolved.rstrip("/")


def _reserve_loopback_socket() -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", 0))
        listener.listen(2048)
    except Exception:
        listener.close()
        raise
    return listener


def _start_internal_agent_listener(
    application: FastAPI,
    listener: socket.socket,
) -> tuple[uvicorn.Server, Thread]:
    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host="127.0.0.1",
            port=int(listener.getsockname()[1]),
            lifespan="off",
            access_log=False,
            log_level="warning",
        )
    )
    thread = Thread(
        target=server.run,
        kwargs={"sockets": [listener]},
        name="embedded-agent-mcp",
        daemon=True,
    )
    thread.start()
    return server, thread


def _build_frontend() -> None:
    executable = shutil.which("npm.cmd") or shutil.which("npm")
    if executable is None:
        raise SystemExit("找不到 npm，无法构建前端")
    result = subprocess.run(
        [executable, "run", "build"],
        cwd=REPOSITORY_ROOT / "frontend",
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit("前端构建失败")


def _discover_lan_address() -> str:
    connection = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        connection.connect(("192.0.2.1", 9))
        address = str(connection.getsockname()[0])
    except OSError:
        address = socket.gethostbyname(socket.gethostname())
    finally:
        connection.close()
    if _is_loopback(address):
        raise SystemExit("无法自动发现局域网地址，请使用 --public-url 显式指定")
    return address


def _is_loopback(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return value.casefold() == "localhost"


if __name__ == "__main__":
    main()
