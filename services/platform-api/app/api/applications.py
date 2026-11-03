from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.auth import require_mcp_service
from app.repositories import ApplicationRepository
from app.schemas import ApplicationList
from app.schemas.applications import Application, Workload


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


@router.get("/{application_id}", response_model=Application, response_model_by_alias=True)
async def get_application(application_id: str) -> Application:
    application = repository.get(application_id)
    if not application:
        raise HTTPException(status_code=404, detail="Application not found")
    return Application.model_validate(application.model_dump(by_alias=True, exclude={"workload_profile"}))


@router.get("/{application_id}/{environment}/workload", response_model=Workload)
async def get_workload(application_id: str, environment: Literal["dev", "prod"]) -> Workload:
    application = repository.get(application_id)
    if not application:
        raise HTTPException(status_code=404, detail="Application not found")
    if not any(item.name == environment and item.enabled for item in application.environments):
        raise HTTPException(status_code=404, detail="Environment not found")
    # Explicit synthetic metadata for the fixture repository, never inferred production state.
    return Workload(platform="cloud_run", stateless=True, http=True, requiresKubernetes=False)
