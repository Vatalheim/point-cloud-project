import io
import pytest
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_api_docs_accessible():
    """Проверка доступности Swagger документации"""
    response = client.get("/docs")
    assert response.status_code == 200

def test_upload_invalid_extension():
    """CHK-UP-04: Реджект неподдерживаемых расширений (.txt)"""
    file_content = b"fake point cloud data"
    files = {"file": ("test.txt", io.BytesIO(file_content), "text/plain")}
    response = client.post("/api/clouds/upload", files=files)
    
    assert response.status_code == 400
    assert "только файлы LAS/LAZ" in response.json()["detail"]

def test_upload_corrupted_empty_file():
    """CHK-UP-05: Реджект пустого/битого файла .las"""
    empty_file = io.BytesIO(b"")
    files = {"file": ("empty.las", empty_file, "application/octet-stream")}
    response = client.post("/api/clouds/upload", files=files)
    
    assert response.status_code == 400
    assert "Некорректный LAS-файл" in response.json()["detail"]

def test_status_non_existent_task():
    """Проверка 404 для неизвестной задачи"""
    response = client.get("/api/clouds/status/non-existent-uuid-1234")
    assert response.status_code == 404
    assert response.json()["detail"] == "Задача не найдена"