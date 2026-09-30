from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PlatformApiError(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    code: Literal[
        "INVALID_INPUT",
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "APPLICATION_NOT_FOUND",
        "INTERNAL_ERROR",
    ]
    message: str
    correlation_id: str = Field(alias="correlationId")
