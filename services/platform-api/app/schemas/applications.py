from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Environment(ContractModel):
    name: Literal["dev", "prod"]
    enabled: bool


class Application(ContractModel):
    application_id: str = Field(alias="applicationId", min_length=1, max_length=200)
    name: str
    team: str
    repository_url: str = Field(alias="repositoryUrl")
    environments: list[Environment]


class WorkloadProfile(ContractModel):
    stateless: bool | None
    request_driven: bool | None = Field(alias="requestDriven")
    long_running: bool | None = Field(alias="longRunning")
    persistent_storage: bool | None = Field(alias="persistentStorage")
    special_networking: bool | None = Field(alias="specialNetworking")
    availability_constraints: list[str] = Field(alias="availabilityConstraints")


class ApplicationDetail(Application):
    workload_profile: WorkloadProfile = Field(alias="workloadProfile")


class ApplicationList(ContractModel):
    applications: list[Application]
    next_cursor: str | None = Field(alias="nextCursor")
