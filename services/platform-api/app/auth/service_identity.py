import hmac
import os

from fastapi import Header, HTTPException


async def require_mcp_service(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv("PLATFORM_API_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="Service authentication is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Service authentication is required")
    supplied = authorization.removeprefix("Bearer ")
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=403, detail="Service identity is not authorized")
