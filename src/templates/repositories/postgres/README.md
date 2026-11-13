# {{APP_NAME}}

Python / Flask / PostgreSQL starter. Creation does not deploy this application.

Run `pip install -r requirements.txt`, configure `DB_HOST`, `DB_PORT` (default 5432),
`DB_NAME`, `DB_USER`, `DB_PASSWORD`, then run `python app.py`.
Open http://localhost:{{APP_PORT}}; `/` records a visit and `/healthz` checks the web process.
Never commit database credentials.

For deployment, choose a PostgreSQL option in the existing portal form: GCP Cloud
SQL or Azure PostgreSQL. PostgreSQL supports concurrent writers using a separate
database server. GCP production failover is configured during deployment, not
during repository creation. Creating this repository does not provision a database.

This starter contains no CI workflow or cloud resources. Review and develop it
before opening the portal's separate deployment form.
