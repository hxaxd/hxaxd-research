from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from mcp.server.fastmcp import FastMCP

from app.agent_tools import (
    AgentCapabilityRegistry,
    AgentToolFacade,
    create_agent_mcp_server,
)
from app.agents import (
    AgentPromptContextBuilder,
    AgentRun,
    AgentRunJobHandler,
    AgentSupervisor,
    PromptAssembler,
    RuntimeMcpCredentials,
    RuntimeOutcome,
    SqliteAgentRunRepository,
)
from app.agents.codex_app_server import (
    CodexAppServerRuntime,
    register_codex_executable,
)
from app.agents.runtime import RuntimeOutcomeStatus, RuntimeRequest
from app.catalog import CatalogCommands, CatalogQueries
from app.changes import ChangeSetRepository, ChangeSetService
from app.device_access import DeviceAccessRepository, DeviceAccessService
from app.documents import (
    BabelDocExtractor,
    DocumentRepository,
    DocumentService,
    OpenAICompatibleTranslationProvider,
    PdfPipelineCapabilityProbe,
    RapidOcrExtractor,
    TexStructureExtractor,
)
from app.history import HistoryQueryService
from app.integrations.zotero import (
    SqliteZoteroTransferRepository,
    V3ZoteroDomainGateway,
    ZoteroLocalClient,
    ZoteroSyncEngine,
    ZoteroTransferService,
    ZoteroWebClient,
)
from app.jobs import JobRegistry, JobScheduler, JobWorker, SqliteJobRepository
from app.library.repository import AttachmentRepository
from app.library.service import AttachmentService
from app.library.storage import AttachmentStorage
from app.operations import OperationHandlers, OperationService
from app.operations.models import ManagedToolName
from app.platform import (
    WorkspaceMutationGate,
    WorkspaceProcessLock,
    ensure_no_activation_residue,
    recover_pending_activation,
)
from app.platform.db import DatabaseKind, WorkspaceDatabase, inspect_database
from app.platform.processes import ExecutableRegistry, ProcessRunner
from app.platform.processes.runner import DEFAULT_ENVIRONMENT_ALLOWLIST
from app.preferences import PreferencesRepository, PreferencesService
from app.reading import ReadingRepository, ReadingService
from app.screening import ScreeningCommands, ScreeningQueries
from app.snapshots import SnapshotService
from app.workspace.models import RuntimeCapability
from app.workspace.service import WorkspaceProjectionService

from .config import Settings


class _UnavailableAgentRuntime:
    name = "codex-app-server"
    version = None

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def run(self, request: RuntimeRequest, *_: Any) -> RuntimeOutcome:
        return RuntimeOutcome(
            status=RuntimeOutcomeStatus.FAILED,
            thread_id=request.thread_id,
            turn_id=None,
            error_code="agent_runtime_unavailable",
            error_message=self.reason,
        )

    def interrupt(self, _: str) -> None:
        return None


@dataclass
class AppContext:
    settings: Settings
    database: WorkspaceDatabase
    attachments: AttachmentService
    catalog: CatalogQueries
    catalog_commands: CatalogCommands
    screening: ScreeningQueries
    screening_commands: ScreeningCommands
    job_repository: SqliteJobRepository
    job_registry: JobRegistry
    job_worker: JobWorker
    jobs: JobScheduler
    process_runner: ProcessRunner
    mutation_gate: WorkspaceMutationGate
    process_lock: WorkspaceProcessLock
    operations: OperationService
    documents: DocumentService
    reading: ReadingService
    preferences: PreferencesService
    device_access: DeviceAccessService
    changes: ChangeSetService
    workspace: WorkspaceProjectionService
    agent_repository: SqliteAgentRunRepository
    agent_supervisor: AgentSupervisor
    agent_prompt_context: AgentPromptContextBuilder
    agent_capabilities: AgentCapabilityRegistry
    agent_runtime_ready: bool
    agent_runtime_message: str
    mcp_server: FastMCP
    snapshots: SnapshotService
    zotero_service: ZoteroTransferService
    history: HistoryQueryService

    def startup(self) -> None:
        self.process_lock.acquire()
        try:
            recover_pending_activation(
                self.settings.activation_journal_path,
                data_dir=self.settings.data_dir,
            )
            ensure_no_activation_residue(
                journal_path=self.settings.activation_journal_path,
                data_dir=self.settings.data_dir,
                database_path=self.settings.database_path,
            )
            self.settings.data_dir.mkdir(parents=True, exist_ok=True)
            self.settings.tools_dir.mkdir(parents=True, exist_ok=True)
            self.settings.agent_work_dir.mkdir(parents=True, exist_ok=True)
            self.settings.operation_staging_dir.mkdir(parents=True, exist_ok=True)
            state = inspect_database(self.settings.database_path)
            if state.kind is DatabaseKind.UNKNOWN:
                raise RuntimeError("数据库不是当前 v4 格式，拒绝启动以避免覆盖数据")
            self.database.initialize()
            self.attachments.storage.initialize()
            self.job_repository.initialize_schema()
            self.agent_repository.initialize_schema()
            self.snapshots.initialize()
            self.operations.reconcile_committed()
            self.documents.reconcile_committed()
            self.snapshots.reconcile_committed()
            self.zotero_service.reconcile_interrupted()
            self.agent_repository.reconcile_interrupted()
            self.job_repository.recover_interrupted()
            self.changes.reconcile_pending()
            self.screening_commands.reconcile_discovery_sessions()
            self.job_worker.start(recover=False)
        except Exception:
            self.process_lock.release()
            raise

    def shutdown(self) -> None:
        try:
            self.job_worker.stop()
            self.process_runner.shutdown()
        finally:
            self.process_lock.release()


def build_app_context(settings: Settings) -> AppContext:
    _validate_internal_agent_base_url(settings.agent_base_url)
    mutation_gate = WorkspaceMutationGate()
    process_lock = WorkspaceProcessLock(settings.runtime_dir / "workspace.lock")
    database = WorkspaceDatabase(settings.database_path)
    storage = AttachmentStorage(settings)
    attachment_repository = AttachmentRepository(database)
    attachments = AttachmentService(attachment_repository, storage)
    history = HistoryQueryService(database)
    catalog = CatalogQueries(database)
    catalog_commands = CatalogCommands(database)
    screening = ScreeningQueries(database)
    screening_commands = ScreeningCommands(database)

    zotero_repository = SqliteZoteroTransferRepository(database)
    zotero_domain = V3ZoteroDomainGateway(
        catalog_queries=catalog,
        catalog_commands=catalog_commands,
        screening_queries=screening,
        screening_commands=screening_commands,
        attachments=attachments,
    )
    zotero_local = ZoteroLocalClient(base_url=settings.zotero_local_url, timeout=1.0)
    zotero_web = (
        ZoteroWebClient(settings.zotero_api_key) if settings.zotero_api_key is not None else None
    )
    zotero_engine = ZoteroSyncEngine(
        domain=zotero_domain,
        repository=zotero_repository,
        local_client=zotero_local,
        web_client=zotero_web,
    )
    zotero_service = ZoteroTransferService(zotero_repository, zotero_engine)

    executable_registry = ExecutableRegistry()
    process_runner = ProcessRunner(
        executable_registry,
        allowed_environment=DEFAULT_ENVIRONMENT_ALLOWLIST
        | frozenset({"PDF2ZH_DEEPSEEK_API_KEY", "HXAXD_MCP_TOKEN"}),
    )
    job_repository = SqliteJobRepository(settings.database_path)
    job_registry = JobRegistry()
    preferences = PreferencesService(PreferencesRepository(database))
    job_worker = JobWorker(
        job_repository,
        job_registry,
        max_workers=8,
        concurrency_provider=lambda: preferences.get().tasks.max_concurrent_jobs,
    )
    jobs = JobScheduler(job_repository, job_worker)
    pdf_capability_probe = PdfPipelineCapabilityProbe(settings, process_runner)
    operations = OperationService(
        settings,
        attachments,
        jobs,
        job_repository,
        process_runner,
        pdf_capability_probe,
        catalog,
    )
    OperationHandlers(settings, attachments, process_runner, pdf_capability_probe).register(
        job_registry
    )
    document_repository = DocumentRepository(database)
    ocr_extractor = RapidOcrExtractor(settings, process_runner)
    document_extractor = BabelDocExtractor(
        settings, process_runner, ocr_extractor, pdf_capability_probe
    )
    tex_structure_extractor = TexStructureExtractor()
    translation_provider = OpenAICompatibleTranslationProvider(
        name=settings.translation_provider,
        model=settings.translation_model,
        base_url=settings.translation_api_base_url,
        api_key=settings.translation_api_key,
    )
    documents = DocumentService(
        document_repository,
        attachments,
        jobs,
        job_repository,
        document_extractor,
        tex_structure_extractor,
        translation_provider,
        preferences,
    )
    documents.register_handlers(job_registry)
    reading = ReadingService(ReadingRepository(database))
    device_access = DeviceAccessService(
        DeviceAccessRepository(database),
        lan_enabled=settings.lan_access_enabled,
        session_days=settings.device_session_days,
    )
    changes = ChangeSetService(
        ChangeSetRepository(database),
        catalog,
        catalog_commands,
        screening,
        screening_commands,
        operations,
        zotero_service,
    )

    agent_runtime_ready = True
    agent_runtime_message = "Codex 应用服务器已就绪"
    try:
        register_codex_executable(
            executable_registry,
            settings.codex_executable,
        )
        agent_runtime = CodexAppServerRuntime(
            process_runner,
            settings.agent_work_dir,
        )
    except (FileNotFoundError, OSError, ValueError) as error:
        agent_runtime_ready = False
        agent_runtime_message = "Codex 应用服务器不可用；请检查本机运行时配置"
        agent_runtime = _UnavailableAgentRuntime(str(error))

    def tool_capability(name: ManagedToolName) -> RuntimeCapability:
        tool = operations.get_tool(name)
        return RuntimeCapability(
            supported=True,
            ready=tool.status.value == "ready",
            message=tool.message,
            details={"version": tool.version},
        )

    def translation_capability() -> RuntimeCapability:
        configured = preferences.get().translation
        ready = (
            translation_provider.ready
            and configured.provider.casefold() == translation_provider.name.casefold()
        )
        return RuntimeCapability(
            supported=True,
            ready=ready,
            message=("整篇翻译与章节自动降级已就绪" if ready else "尚未配置所选整篇翻译服务或密钥"),
            details={
                "provider": configured.provider,
                "model": configured.model,
                "mode": configured.batching,
            },
        )

    workspace = WorkspaceProjectionService(
        database,
        settings.data_dir,
        capability_providers={
            "durable_jobs": lambda: _job_worker_capability(job_worker),
            "pdf_translation": lambda: tool_capability(ManagedToolName.PDF2ZH),
            "semantic_documents": lambda: RuntimeCapability(
                supported=True,
                ready=document_extractor.ready,
                message=(
                    "结构提取与扫描件 OCR 已就绪；特殊块识别和外部译文回注仍受限"
                    if document_extractor.ready and document_extractor.true_ocr_ready
                    else "BabelDOC 结构化提取已就绪；升级 PDF 工具可启用扫描件 OCR"
                    if document_extractor.ready
                    else "安装 PDF 论文翻译工具后即可生成结构化文档"
                ),
                details={
                    "extractor": document_extractor.name,
                    "version": document_extractor.version,
                    "pdf2zh_version": pdf_capability_probe.get().pdf2zh_version,
                    "babeldoc_version": pdf_capability_probe.get().babeldoc_version,
                    "true_ocr": document_extractor.true_ocr_ready,
                    "ocr_engine": ocr_extractor.name,
                    "ocr_version": ocr_extractor.version,
                    "page_coordinates": pdf_capability_probe.get().page_coordinates,
                    "reading_order": pdf_capability_probe.get().reading_order,
                    "paragraph_boundaries": pdf_capability_probe.get().paragraph_boundaries,
                    "block_classification": pdf_capability_probe.get().block_classification,
                    "specialized_block_types": (pdf_capability_probe.get().specialized_block_types),
                    "ocr_confidence": pdf_capability_probe.get().ocr_confidence,
                    "external_translation_injection": (
                        pdf_capability_probe.get().external_block_translation_injection
                    ),
                    "external_translation_pdf": (
                        pdf_capability_probe.get().translated_pdf_from_external_blocks
                    ),
                    "tex_structure_priority": True,
                    "tex_structure_version": tex_structure_extractor.version,
                },
            ),
            "whole_document_translation": translation_capability,
            "tex_compile": lambda: tool_capability(ManagedToolName.TEX),
            "embedded_agent": lambda: RuntimeCapability(
                supported=True,
                ready=agent_runtime_ready,
                message=agent_runtime_message,
            ),
            "zotero": lambda: _zotero_capability(zotero_service),
        },
    )

    agent_capabilities = AgentCapabilityRegistry()
    agent_tools = AgentToolFacade(
        workspace,
        catalog,
        screening,
        screening_commands,
        changes,
        zotero_service,
    )
    mcp_server = create_agent_mcp_server(
        agent_tools,
        agent_capabilities,
        public_base_url=settings.agent_base_url,
    )
    agent_repository = SqliteAgentRunRepository(settings.database_path)
    agent_prompt_context = AgentPromptContextBuilder(
        catalog,
        screening,
        attachments,
        zotero_service,
        documents=documents,
        reading=reading,
        preferences=preferences,
    )

    def mcp_credentials(run: AgentRun) -> RuntimeMcpCredentials:
        agent_capabilities.revoke_run(run.id)
        token = agent_capabilities.issue(
            run.id,
            project_id=run.project_id,
            item_id=run.item_id,
            target_type=run.target_type,
            target_id=run.target_id,
            scopes=frozenset(run.tool_scopes),
        )
        return RuntimeMcpCredentials(
            url=f"{settings.agent_base_url.rstrip('/')}/mcp/",
            bearer_token=token,
            enabled_tools=agent_prompt_context.tools_for_scopes(run.tool_scopes),
        )

    agent_supervisor = AgentSupervisor(
        agent_repository,
        agent_runtime,
        PromptAssembler(),
        settings.agent_work_dir,
        mcp_credentials=mcp_credentials,
        mcp_revoke=agent_capabilities.revoke_run,
    )
    job_registry.register(
        "agent.run",
        AgentRunJobHandler(
            agent_supervisor,
            finish_discovery_sessions=screening_commands.finish_discovery_sessions,
        ),
    )

    snapshots = SnapshotService(
        settings,
        database,
        job_repository,
        jobs,
        mutation_gate=mutation_gate,
    )
    snapshots.register_handlers(job_registry)

    return AppContext(
        settings=settings,
        database=database,
        attachments=attachments,
        catalog=catalog,
        catalog_commands=catalog_commands,
        screening=screening,
        screening_commands=screening_commands,
        job_repository=job_repository,
        job_registry=job_registry,
        job_worker=job_worker,
        jobs=jobs,
        process_runner=process_runner,
        mutation_gate=mutation_gate,
        process_lock=process_lock,
        operations=operations,
        documents=documents,
        reading=reading,
        preferences=preferences,
        device_access=device_access,
        changes=changes,
        workspace=workspace,
        agent_repository=agent_repository,
        agent_supervisor=agent_supervisor,
        agent_prompt_context=agent_prompt_context,
        agent_capabilities=agent_capabilities,
        agent_runtime_ready=agent_runtime_ready,
        agent_runtime_message=agent_runtime_message,
        mcp_server=mcp_server,
        snapshots=snapshots,
        zotero_service=zotero_service,
        history=history,
    )


def _zotero_capability(service: ZoteroTransferService) -> RuntimeCapability:
    status = service.status()
    ready = status.import_available or status.export_available
    messages = [status.local.message, status.web.message]
    return RuntimeCapability(
        supported=True,
        ready=ready,
        message=" ".join(messages),
        details={
            "import_available": status.import_available,
            "export_available": status.export_available,
            "local_read_only": status.local.read_only,
        },
    )


def _job_worker_capability(worker: JobWorker) -> RuntimeCapability:
    worker_alive = worker.is_alive
    last_error = worker.last_error
    ready = worker_alive and last_error is None
    if ready:
        message = "持久任务工作线程运行中"
    elif last_error is not None:
        message = "持久任务工作线程发生异常，正在重试"
    else:
        message = "持久任务工作线程未运行"
    return RuntimeCapability(
        supported=True,
        ready=ready,
        message=message,
        details={
            "worker_alive": worker_alive,
            "error_code": "job_worker_error" if last_error is not None else None,
        },
    )


def _validate_internal_agent_base_url(value: str) -> None:
    parsed = urlsplit(value)
    hostname = parsed.hostname or ""
    try:
        local = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        local = hostname.casefold() == "localhost"
    if parsed.scheme not in {"http", "https"} or not local:
        raise ValueError("agent_base_url must use an HTTP(S) loopback address")
