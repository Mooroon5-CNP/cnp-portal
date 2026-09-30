from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.applications import router as applications_router
from app.schemas.errors import PlatformApiError


app = FastAPI(
    title="CNP Platform API",
    version="1.0.0",
    description="Read-only application catalog consumed by the CNP MCP server.",
)


@app.middleware("http")
async def correlation_id(request: Request, call_next):
    value = request.headers.get("x-correlation-id") or str(uuid4())
    request.state.correlation_id = value
    response = await call_next(request)
    response.headers["x-correlation-id"] = value
    return response


def error_response(request: Request, status_code: int, code: str, message: str) -> JSONResponse:
    body = PlatformApiError(
        code=code,
        message=message,
        correlationId=request.state.correlation_id,
    )
    return JSONResponse(status_code=status_code, content=body.model_dump(by_alias=True))


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, _error: RequestValidationError):
    return error_response(request, 400, "INVALID_INPUT", "The request is invalid.")


@app.exception_handler(HTTPException)
async def http_error(request: Request, error: HTTPException):
    codes = {400: "INVALID_INPUT", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "APPLICATION_NOT_FOUND"}
    code = codes.get(error.status_code, "INTERNAL_ERROR")
    message = str(error.detail) if error.status_code < 500 else "Internal server error."
    return error_response(request, error.status_code, code, message)


@app.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readiness() -> dict[str, str]:
    return {"status": "ready"}


app.include_router(applications_router)
