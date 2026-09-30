# CNP Platform API

Independent, read-only FastAPI service for the MCP application catalog.

```bash
cd services/platform-api
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
PLATFORM_API_SERVICE_TOKEN=local-service-token uvicorn app.main:app --reload --port 8080
```

The current repository adapter uses contract fixtures. Replacing it with the
SQLAlchemy/PostgreSQL repository does not change the HTTP models or routes.
