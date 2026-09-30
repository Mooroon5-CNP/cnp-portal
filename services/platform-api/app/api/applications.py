from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.auth import require_mcp_service
from app.repositories import ApplicationRepository
from app.schemas import ApplicationDetail, ApplicationList


router = APIRouter(prefix="/v1/applications", dependencies=[Depends(require_mcp_service)])
repository = ApplicationRepository()


@router.get("", response_model=ApplicationList, response_model_by_alias=True)
async def list_applications(
    request: Request,
    query: Annotated[str | None, Query(max_length=200)] = None,
    environment: Literal["dev", "prod"] | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query(max_length=1000)] = None,
) -> ApplicationList:
    del request
    try:
        applications, next_cursor = repository.list(query, environment, limit, cursor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return ApplicationList(applications=applications, nextCursor=next_cursor)


@router.get("/{application_id}", response_model=ApplicationDetail, response_model_by_alias=True)
async def get_application(application_id: str) -> ApplicationDetail:
    application = repository.get(application_id)
    if not application:
        raise HTTPException(status_code=404, detail="Application not found")
    return application
