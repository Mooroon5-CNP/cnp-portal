"""{{APP_NAME}} — SQLite starter. Configure persistent storage when deploying."""
import os
import sqlite3
from pathlib import Path
from flask import Flask, jsonify

app = Flask(__name__)


@app.get('/healthz')
def health():
    return jsonify(status='ok')


@app.get('/')
def index():
    database = os.environ.get('SQLITE_PATH', '/data/app.db')
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database, timeout=10) as connection:
        connection.execute(
            'CREATE TABLE IF NOT EXISTS visits '
            '(id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP)'
        )
        connection.execute('INSERT INTO visits DEFAULT VALUES')
        count = connection.execute('SELECT COUNT(*) FROM visits').fetchone()[0]
    return jsonify(application='{{APP_NAME}}', database='sqlite', visits=count)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', '{{APP_PORT}}')))
