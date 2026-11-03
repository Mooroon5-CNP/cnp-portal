import base64
import json

from app.schemas.applications import Application, ApplicationDetail, WorkloadProfile


_FIXTURES = [
    ApplicationDetail(
        applicationId="majoutes-api",
        name="Majoutes API",
        team="majoutes",
        repositoryUrl="https://git.example/majoutes-api",
        environments=[
            {"name": "dev", "enabled": True},
            {"name": "prod", "enabled": True},
        ],
        workloadProfile=WorkloadProfile(
            stateless=True,
            requestDriven=True,
            longRunning=False,
            persistentStorage=False,
            specialNetworking=None,
            availabilityConstraints=[],
        ),
    )
]


def _encode_cursor(offset: int) -> str:
    payload = json.dumps({"offset": offset}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded).decode())
        offset = value["offset"]
        if not isinstance(offset, int) or offset < 0:
            raise ValueError
        return offset
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid cursor") from error


class ApplicationRepository:
    def list(
        self,
        query: str | None,
        environment: str | None,
        limit: int,
        cursor: str | None,
    ) -> tuple[list[Application], str | None]:
        offset = _decode_cursor(cursor)
        normalized_query = query.casefold() if query else None
        records = [
            item for item in _FIXTURES
            if (not normalized_query or normalized_query in item.name.casefold()
                or normalized_query in item.application_id.casefold())
            and (not environment or any(env.name == environment and env.enabled for env in item.environments))
        ]
        page = records[offset:offset + limit]
        next_offset = offset + len(page)
        next_cursor = _encode_cursor(next_offset) if next_offset < len(records) else None
        summaries = [
            Application(
                applicationId=item.application_id,
                name=item.name,
                team=item.team,
                repositoryUrl=item.repository_url,
                environments=item.environments,
            )
            for item in page
        ]
        return summaries, next_cursor

    def get(self, application_id: str) -> ApplicationDetail | None:
        return next((item for item in _FIXTURES if item.application_id == application_id), None)
