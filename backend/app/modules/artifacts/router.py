from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from fastapi.responses import FileResponse

from app.core.dependencies import get_app_context

from .models import Artifact, ArtifactKind
from .service import ArtifactService

router = APIRouter(prefix="/papers/{paper_id}/artifacts", tags=["artifacts"])


def get_service(request: Request) -> ArtifactService:
    return get_app_context(request).artifacts


@router.get("", response_model=list[Artifact])
def list_artifacts(
    paper_id: str,
    service: Annotated[ArtifactService, Depends(get_service)],
) -> list[Artifact]:
    return service.list_by_paper(paper_id)


@router.post("/{kind}", response_model=Artifact, status_code=201)
async def upload_artifact(
    paper_id: str,
    kind: ArtifactKind,
    upload: Annotated[UploadFile, File()],
    service: Annotated[ArtifactService, Depends(get_service)],
) -> Artifact:
    return await service.save_upload(paper_id, kind, upload)


@router.get("/{kind}")
def get_artifact(
    paper_id: str,
    kind: ArtifactKind,
    service: Annotated[ArtifactService, Depends(get_service)],
    download: Annotated[bool, Query()] = False,
) -> FileResponse:
    artifact, path = service.locate(paper_id, kind)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=artifact.filename,
        content_disposition_type="attachment" if download else "inline",
    )
