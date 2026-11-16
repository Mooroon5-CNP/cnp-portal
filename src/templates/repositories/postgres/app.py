"""{{APP_NAME}} — PostgreSQL starter using the platform's DB_* variables."""
import os
import psycopg
from flask import Flask, jsonify

app = Flask(__name__)


@app.get('/healthz')
def health():
    return jsonify(status='ok')


@app.get('/')
def index():
    with psycopg.connect(
        host=os.environ['DB_HOST'], port=os.environ.get('DB_PORT', '5432'),
        dbname=os.environ['DB_NAME'], user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'], connect_timeout=10,
    ) as connection:
        connection.execute(
            'CREATE TABLE IF NOT EXISTS visits '
            '(id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)'
        )
        connection.execute('INSERT INTO visits DEFAULT VALUES')
        count = connection.execute('SELECT COUNT(*) FROM visits').fetchone()[0]
    return jsonify(application='{{APP_NAME}}', database='postgres', visits=count)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', '{{APP_PORT}}')))
