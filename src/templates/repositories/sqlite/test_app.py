from app import app


def test_health():
    assert app.test_client().get('/healthz').json == {'status': 'ok'}


def test_visits_persist(tmp_path, monkeypatch):
    monkeypatch.setenv('SQLITE_PATH', str(tmp_path / 'visits.db'))
    client = app.test_client()
    assert client.get('/').json['visits'] == 1
    assert client.get('/').json['visits'] == 2
