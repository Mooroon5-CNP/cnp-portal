from unittest.mock import MagicMock, patch
from app import app


def test_health_does_not_require_database():
    assert app.test_client().get('/healthz').json == {'status': 'ok'}


def test_readiness_requires_writable_database(monkeypatch):
    for key in ('DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'):
        monkeypatch.setenv(key, 'configured')
    connection = MagicMock()
    with patch('app.psycopg.connect') as connect:
        connect.return_value.__enter__.return_value = connection
        connection.execute.return_value.fetchone.return_value = ('off',)
        assert app.test_client().get('/health').status_code == 200
        connection.execute.return_value.fetchone.return_value = ('on',)
        assert app.test_client().get('/health').status_code == 503
    connection.execute.assert_called_with('SHOW transaction_read_only')


def test_readiness_reports_missing_database_configuration(monkeypatch):
    monkeypatch.delenv('DB_HOST', raising=False)
    assert app.test_client().get('/health').status_code == 503


def test_database_uses_platform_configuration(monkeypatch):
    for key, value in {'DB_HOST': 'database', 'DB_NAME': 'demo',
                       'DB_USER': 'user', 'DB_PASSWORD': 'secret'}.items():
        monkeypatch.setenv(key, value)
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = (2,)
    with patch('app.psycopg.connect') as connect:
        connect.return_value.__enter__.return_value = connection
        response = app.test_client().get('/')
        assert response.json['visits'] == 2
        connect.assert_called_once_with(
            host='database', port='5432', dbname='demo',
            user='user', password='secret', connect_timeout=10,
        )
