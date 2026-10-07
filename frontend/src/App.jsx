import React, { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';

export default function App() {
  const cesiumContainer = useRef(null);
  const viewerRef = useRef(null);
  const currentTilesetRef = useRef(null);

  const [file, setFile] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [canZoom, setCanZoom] = useState(false);
  const [pointColor, setPointColor] = useState("#00e5ff"); // Яркий бирюзовый по умолчанию

  // 1. Инициализация глобуса с бесплатной спутниковой картой ESRI
  useEffect(() => {
    if (!cesiumContainer.current) return;

    // Бесплатная спутниковая подложка (работает без ключей и токенов)
    const esriImagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19
    });

    const viewer = new Cesium.Viewer(cesiumContainer.current, {
      baseLayer: new Cesium.ImageryLayer(esriImagery),
      imageryProvider: esriImagery,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
    });

    // Включаем отображение атмосферы и освещения
    viewer.scene.globe.show = true;
    viewer.scene.skyAtmosphere.show = true;

    viewerRef.current = viewer;

    return () => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.destroy();
      }
    };
  }, []);

  // Функция применения стиля к облаку точек
  const applyPointStyle = (tileset) => {
    if (!tileset) return;
    tileset.style = new Cesium.Cesium3DTileStyle({
      pointSize: 2.0, // Уменьшаем размер, чтобы видеть структуру деревьев
      color: {
        // Раскраска по высоте над уровнем моря (Z)
        conditions: [
          ['${POSITION}[2] > 150', 'color("#ff3333")'], // Самые высокие верхушки деревьев (красный)
          ['${POSITION}[2] > 140', 'color("#ffaa00")'], // Средняя крона (оранжевый)
          ['${POSITION}[2] > 132', 'color("#33cc33")'], // Нижние ветки и кустарники (зеленый)
          ['true', 'color("#0088ff")']                  // Земля и дорога (синий)
        ]
      }
    });
  };

  // Реакция на изменение цвета из UI
  useEffect(() => {
    if (currentTilesetRef.current) {
      applyPointStyle(currentTilesetRef.current, pointColor);
    }
  }, [pointColor]);

  const handleUpload = async () => {
    if (!file) return;
    setIsLoading(true);
    setStatusMsg("Отправка файла на сервер...");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://localhost:8000/api/clouds/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка загрузки");

      setStatusMsg("Конвертация в 3D Tiles...");
      pollStatus(data.task_id);
    } catch (err) {
      setStatusMsg(`Ошибка: ${err.message}`);
      setIsLoading(false);
    }
  };

  const pollStatus = (taskId) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:8000/api/clouds/status/${taskId}`);
        const data = await res.json();

        if (data.status === "processing") {
          setStatusMsg(data.message);
        } else if (data.status === "success") {
          clearInterval(interval);
          setStatusMsg("Отрисовка на глобусе...");
          loadTileset(data.tileset_url);
        } else if (data.status === "failed") {
          clearInterval(interval);
          setStatusMsg(`Сбой: ${data.message}`);
          setIsLoading(false);
        }
      } catch (err) {
        clearInterval(interval);
        setStatusMsg("Сбой связи с сервером");
        setIsLoading(false);
      }
    }, 2000);
  };

  const loadTileset = async (tilesetUrl) => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    try {
      if (currentTilesetRef.current) {
        viewer.scene.primitives.remove(currentTilesetRef.current);
      }

      const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
        maximumScreenSpaceError: 16,
      });

      // Применяем яркий стиль и размер точек
      applyPointStyle(tileset, pointColor);

      viewer.scene.primitives.add(tileset);
      currentTilesetRef.current = tileset;

      setCanZoom(true);
      setIsLoading(false);
      setStatusMsg("Облако успешно загружено!");
      handleZoom();
    } catch (error) {
      setStatusMsg(`Ошибка рендера: ${error}`);
      setIsLoading(false);
    }
  };

  const handleZoom = () => {
    const viewer = viewerRef.current;
    const tileset = currentTilesetRef.current;
    if (viewer && tileset) {
      viewer.zoomTo(tileset, new Cesium.HeadingPitchRange(0, -0.6, 0));
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
      <div ref={cesiumContainer} style={{ width: '100%', height: '100%' }} />

      <div style={{
        position: 'absolute', top: 20, left: 20, background: 'rgba(255, 255, 255, 0.95)',
        padding: '16px', borderRadius: '8px', zIndex: 999, display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '320px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontFamily: 'sans-serif'
      }}>
        <h3 style={{ margin: '0', fontSize: '16px', color: '#111' }}>Управление облаком точек</h3>
        
        <input 
          type="file" 
          accept=".las,.laz" 
          onChange={(e) => setFile(e.target.files[0])} 
          style={{ fontSize: '13px' }}
        />

        <button 
          onClick={handleUpload} 
          disabled={!file || isLoading}
          style={{ 
            padding: '10px', 
            cursor: file && !isLoading ? 'pointer' : 'not-allowed', 
            background: '#007bff', 
            color: '#fff', 
            border: 'none', 
            borderRadius: '4px',
            fontWeight: 'bold'
          }}
        >
          {isLoading ? "Обработка..." : "Загрузить на сцену"}
        </button>

        {/* Выбор цвета облака */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
          <label style={{ fontSize: '13px', fontWeight: '500' }}>Цвет точек:</label>
          <input 
            type="color" 
            value={pointColor} 
            onChange={(e) => setPointColor(e.target.value)} 
            style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
          />
        </div>

        {canZoom && (
          <button 
            onClick={handleZoom} 
            style={{ 
              padding: '10px', 
              cursor: 'pointer', 
              background: '#28a745', 
              color: '#fff', 
              border: 'none', 
              borderRadius: '4px',
              fontWeight: 'bold'
            }}
          >
            🎯 Прилететь к облаку
          </button>
        )}

        {statusMsg && (
          <div style={{ fontSize: '12px', marginTop: '4px', color: '#444' }}>
            {statusMsg}
          </div>
        )}
      </div>
    </div>
  );
}