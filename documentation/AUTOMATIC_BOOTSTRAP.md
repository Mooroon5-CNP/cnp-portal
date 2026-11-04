The portal starts without configuring SESSION_SECRET or ADMIN_INITIAL_PASSWORD.
A session key is generated once per process unless a suitable key is configured.
On a fresh database, an admin password is generated and written to
`admin-initial-password` beside the SQLite database. It is never logged or served
by HTTP. The file is created with mode 0600; external mounts control their own
permissions. Infrastructure operators can read it through the data volume's
administrative access. A supplied ADMIN_INITIAL_PASSWORD takes precedence for
initial bootstrap. Existing custom admin passwords are preserved.

Cloud Run supplies PORT; the server binds to 0.0.0.0 in production. A generic
startup-probe error requires the revision's application logs to identify the
actual cause. Successful unit tests do not establish Cloud Run readiness.
