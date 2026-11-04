import os
import uuid
import subprocess
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import laspy

app = FastAPI(title="Point Cloud Processing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("/app/data/uploads")
TILESET_DIR = Path("/app/data/tilesets")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TILESET_DIR.mkdir(parents=True, exist_ok=True)

tasks_status = {}

app.mount("/tilesets", StaticFiles(directory=str(TILESET_DIR)), name="tilesets")

def convert_las_to_3dtiles(task_id: str, input_path: Path, output_path: Path):
    """Фоновый воркер конвертации"""
    tasks_status[task_id]["status"] = "processing"
    tasks_status[task_id]["message"] = "Идет конвертация в 3D Tiles..."
    try:
        cmd = [
            "py3dtiles", "convert",
            str(input_path),
            "--out", str(output_path),
            "--srs_out", "4978",
            "--jobs", "2",
            "--overwrite"
        ]
        
        subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            check=True
        )
        
        tasks_status[task_id]["status"] = "success"
        tasks_status[task_id]["message"] = "Конвертация успешно завершена"
        tasks_status[task_id]["tileset_url"] = f"/tilesets/{task_id}/tileset.json"
    except subprocess.TimeoutExpired:
        tasks_status[task_id]["status"] = "failed"
        tasks_status[task_id]["message"] = "Превышено время ожидания конвертации"
    except subprocess.CalledProcessError as e:
        tasks_status[task_id]["status"] = "failed"
        tasks_status[task_id]["message"] = f"Ошибка конвертера: {e.stderr}"
    except Exception as e:
        tasks_status[task_id]["status"] = "failed"
        tasks_status[task_id]["message"] = f"Внутренняя ошибка: {str(e)}"

@app.post("/api/clouds/upload")
async def upload_cloud(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Загрузка, валидация и подсчет точек"""
    if not (file.filename.endswith(".las") or file.filename.endswith(".laz")):
        raise HTTPException(status_code=400, detail="Ошибка: принимаются только файлы LAS/LAZ")

    task_id = str(uuid.uuid4())
    temp_file_path = UPLOAD_DIR / f"{task_id}_{file.filename}"
    
    with open(temp_file_path, "wb") as buffer:
        buffer.write(await file.read())

    point_count = 0
    try:
        with laspy.open(temp_file_path) as las_file:
            crs = las_file.header.parse_crs()
            point_count = int(las_file.header.point_count)
            if not crs:
                if os.path.exists(temp_file_path):
                    os.remove(temp_file_path)
                raise HTTPException(
                    status_code=400, 
                    detail="Внимание: В файле отсутствует информация о системе координат (CRS/SRS)!"
                )
    except HTTPException:
        raise
    except Exception as err:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)
        raise HTTPException(status_code=400, detail=f"Некорректный LAS-файл: {str(err)}")

    out_folder = TILESET_DIR / task_id
    out_folder.mkdir(parents=True, exist_ok=True)

    tasks_status[task_id] = {
        "status": "queued",
        "message": "Файл в очереди на обработку",
        "filename": file.filename,
        "point_count": point_count,
        "tileset_url": None
    }

    background_tasks.add_task(convert_las_to_3dtiles, task_id, temp_file_path, out_folder)

    return {"task_id": task_id, "status": "queued"}

@app.get("/api/clouds/status/{task_id}")
async def get_status(task_id: str):
    if task_id not in tasks_status:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    return tasks_status[task_id]