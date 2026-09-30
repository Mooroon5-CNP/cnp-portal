import os

import httpx
import pytest

os.environ["PLATFORM_API_SERVICE_TOKEN"] = "test-service-token"

from app.main import app  # noqa: E402


headers = {"Authorization": "Bearer test-service-token", "X-Correlation-ID": "test-correlation"}


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as value:
        yield value


@pytest.mark.anyio
async def test_health_routes_are_public(client):
    assert (await client.get("/healthz")).status_code == 200
    assert (await client.get("/readyz")).status_code == 200


@pytest.mark.anyio
async def test_catalog_requires_service_identity(client):
    response = await client.get("/v1/applications")
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"


@pytest.mark.anyio
async def test_lists_contract_shaped_applications(client):
    response = await client.get("/v1/applications?environment=dev", headers=headers)
    assert response.status_code == 200
    assert response.json()["applications"][0]["applicationId"] == "majoutes-api"
    assert response.json()["nextCursor"] is None
    assert response.headers["x-correlation-id"] == "test-correlation"


@pytest.mark.anyio
async def test_returns_application_detail(client):
    response = await client.get("/v1/applications/majoutes-api", headers=headers)
    assert response.status_code == 200
    assert response.json()["workloadProfile"]["stateless"] is True


@pytest.mark.anyio
async def test_unknown_application_has_normalized_error(client):
    response = await client.get("/v1/applications/unknown", headers=headers)
    assert response.status_code == 404
    assert response.json() == {
        "code": "APPLICATION_NOT_FOUND",
        "message": "Application not found",
        "correlationId": "test-correlation",
    }


@pytest.mark.anyio
async def test_invalid_limit_is_a_400(client):
    response = await client.get("/v1/applications?limit=101", headers=headers)
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_INPUT"
