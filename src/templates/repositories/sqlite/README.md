# {{APP_NAME}}

Python / Flask / SQLite starter. Creation does not deploy this application.

Run `pip install -r requirements.txt`, then `SQLITE_PATH=./app.db python app.py`.
Open http://localhost:{{APP_PORT}}; `/` records a visit and `/healthz` checks the web process.

For deployment, choose the existing GCP SQLite option with persistent storage at
`/data`. The default database path is `/data/app.db` (`SQLITE_PATH` overrides it).
SQLite suits modest concurrent writes. Do not share a SQLite file between multiple
application instances. For more concurrent writes or PostgreSQL failover, use the
PostgreSQL template. Failover and production availability depend on deployment configuration.

This starter contains no CI workflow or cloud resources. Review and develop it
before opening the portal's separate deployment form.
