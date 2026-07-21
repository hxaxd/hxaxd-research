from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.platform.db import V3Database

from .domain import CatalogNotFoundError
from .models import BibliographicItemView, WorkList, WorkView
from .queries import CatalogQueries

router = APIRouter(tags=["catalog"])


def get_v3_database(request: Request) -> V3Database:
    database = getattr(request.app.state, "v3_database", None)
    if not isinstance(database, V3Database):
        raise RuntimeError("v3 database is not configured")
    return database


def get_queries(database: Annotated[V3Database, Depends(get_v3_database)]) -> CatalogQueries:
    return CatalogQueries(database)


@router.get("/works", response_model=WorkList)
def list_works(
    queries: Annotated[CatalogQueries, Depends(get_queries)],
    search: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> WorkList:
    return queries.list_works(search=search, limit=limit, offset=offset)


@router.get("/works/{work_id}", response_model=WorkView)
def get_work(
    work_id: str, queries: Annotated[CatalogQueries, Depends(get_queries)]
) -> WorkView:
    try:
        return queries.get_work(work_id)
    except CatalogNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/items/{item_id}", response_model=BibliographicItemView)
def get_item(
    item_id: str, queries: Annotated[CatalogQueries, Depends(get_queries)]
) -> BibliographicItemView:
    try:
        return queries.get_item(item_id)
    except CatalogNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
