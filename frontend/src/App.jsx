import React, { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';

Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwZjE0YjBiYy1iNjZiLTQ5ZWQtOTBmOS0yODQxZjYyMGQ0ZGIiLCJpZCI6MjY5MDcsImlhdCI6MTcxMzQzOTMxMH0.O4RDeS46mL3ABENB4wHIbiFPdCj8ze1xYPUrDrRVs1Y';

const DEFAULT_COLORS = ["#00e5ff", "#ff0055", "#00ff66", "#ffaa00", "#9d00ff"];

export default function App() {
  const cesiumContainer = useRef(null);
  const viewerRef = useRef(null);
  const handlerRef = useRef(null);

  // Список облаков. Теперь каждое облако хранит СВОИ удаленные и перекрашенные точки
  // { id, name, tileset, visible, color, pointCount, heightOffset, deletedSpots: [], coloredSpots: [], history: [] }
  const [clouds, setClouds] = useState([]);
  const [activeCloudId, setActiveCloudId] = useState(null); // ID выбранного облака для правки (ТЗ)

  const [file, setFile] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Режим редактирования
  const [editMode, setEditMode] = useState(false);
  const [selectionMode, setSelectionMode] = useState("single");
  const [editAction, setEditAction] = useState("delete");
  const [brushRadius, setBrushRadius] = useState(3.0);
  const [brushColor, setBrushColor] = useState("#ff0000");

  // Инициализация глобуса
  useEffect(() => {
    if (!cesiumContainer.current) return;

    const esriImagery = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19
    });

    const viewer = new Cesium.Viewer(cesiumContainer.current, {
      baseLayer: new Cesium.ImageryLayer(esriImagery),
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

    viewer.scene.debugShowFramesPerSecond = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.globe.show = true;
    viewer.scene.skyAtmosphere.show = true;

    Cesium.createWorldTerrainAsync({ requestVertexNormals: true })
      .then(terrain => { viewer.terrainProvider = terrain; })
      .catch(e => console.warn("Terrain error:", e));

    Cesium.createOsmBuildingsAsync()
      .then(buildings => { viewer.scene.primitives.add(buildings); })
      .catch(e => console.warn("Buildings error:", e));

    viewerRef.current = viewer;

    return () => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.destroy();
      }
    };
  }, []);

  const getFrontPointPosition = (viewer, screenPosition) => {
    let closestCartesian = null;
    let minDistance = Infinity;
    const cameraPos = viewer.camera.positionWC;

    const offsets = [
      { x: 0, y: 0 },
      { x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: -2 }, { x: 0, y: 2 },
      { x: -3, y: -3 }, { x: 3, y: -3 }, { x: -3, y: 3 }, { x: 3, y: 3 },
      { x: -4, y: 0 }, { x: 4, y: 0 }, { x: 0, y: -4 }, { x: 0, y: 4 }
    ];

    for (const off of offsets) {
      const samplePos = new Cesium.Cartesian2(screenPosition.x + off.x, screenPosition.y + off.y);
      const pos = viewer.scene.pickPosition(samplePos);
      if (Cesium.defined(pos)) {
        const dist = Cesium.Cartesian3.distance(cameraPos, pos);
        if (dist < minDistance) {
          minDistance = dist;
          closestCartesian = pos;
        }
      }
    }

    if (!closestCartesian) {
      const ray = viewer.camera.getPickRay(screenPosition);
      closestCartesian = viewer.scene.pickPosition(screenPosition) || viewer.scene.globe.pick(ray, viewer.scene);
    }

    return closestCartesian;
  };

  // Шейдерное обновление конкретного облака
  const updateCloudShaderStyle = (tileset, baseColor, deletions, colorings) => {
    if (!tileset) return;

    const defines = {};
    const deleteChecks = [];
    const colorConditions = [];

    deletions.forEach((spot, i) => {
      const varName = `del_${i}`;
      defines[varName] = `distance(\${POSITION_ABSOLUTE}, vec3(${spot.x}, ${spot.y}, ${spot.z}))`;
      deleteChecks.push(`\${${varName}} < ${spot.r}`);
    });

    colorings.forEach((spot, i) => {
      const varName = `col_${i}`;
      defines[varName] = `distance(\${POSITION_ABSOLUTE}, vec3(${spot.x}, ${spot.y}, ${spot.z}))`;
      colorConditions.push([`\${${varName}} < ${spot.r}`, `color('${spot.color}')`]);
    });

    colorConditions.push(["true", `color('${baseColor}')`]);
    const showRule = deleteChecks.length > 0 ? `!(${deleteChecks.join(" || ")})` : "true";

    tileset.style = new Cesium.Cesium3DTileStyle({
      defines: defines,
      pointSize: 3.5,
      show: showRule,
      color: { conditions: colorConditions }
    });
  };

  // Клик по точкам: теперь применяем к ВЫБРАННОМУ (активному) облаку
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (handlerRef.current) {
      handlerRef.current.destroy();
      handlerRef.current = null;
    }

    if (editMode && clouds.length > 0) {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

      handler.setInputAction((movement) => {
        const cartesian = getFrontPointPosition(viewer, movement.position);

        if (Cesium.defined(cartesian)) {
          // Ищем активное облако по activeCloudId
          const activeCloud = clouds.find(c => c.id === activeCloudId) || clouds[0];
          if (!activeCloud) return;

          const effectiveRadius = selectionMode === "single" ? 0.35 : brushRadius;

          setClouds(prev => prev.map(c => {
            if (c.id !== activeCloud.id) return c;

            let nextDeletions = c.deletedSpots;
            let nextColorings = c.coloredSpots;
            let newAction = null;

            if (editAction === "delete") {
              const spot = { x: cartesian.x, y: cartesian.y, z: cartesian.z, r: effectiveRadius };
              nextDeletions = [...c.deletedSpots, spot];
              newAction = { type: 'delete', spot };
              setStatusMsg(`[${c.name}] Удалена область`);
            } else if (editAction === "color") {
              const spot = { x: cartesian.x, y: cartesian.y, z: cartesian.z, r: effectiveRadius, color: brushColor };
              nextColorings = [...c.coloredSpots, spot];
              newAction = { type: 'color', spot };
              setStatusMsg(`[${c.name}] Точки перекрашены`);
            }

            updateCloudShaderStyle(c.tileset, c.color, nextDeletions, nextColorings);

            return {
              ...c,
              deletedSpots: nextDeletions,
              coloredSpots: nextColorings,
              history: [...c.history, newAction]
            };
          }));
        } else {
          setStatusMsg("Клик мимо облака точек");
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      handlerRef.current = handler;
    }

    return () => {
      if (handlerRef.current && !handlerRef.current.isDestroyed()) {
        handlerRef.current.destroy();
        handlerRef.current = null;
      }
    };
  }, [editMode, selectionMode, editAction, brushRadius, brushColor, clouds, activeCloudId]);

  // Undo для активного облака
  const handleUndo = () => {
    const activeCloud = clouds.find(c => c.id === activeCloudId) || clouds[0];
    if (!activeCloud || activeCloud.history.length === 0) return;

    setClouds(prev => prev.map(c => {
      if (c.id !== activeCloud.id) return c;

      const lastAction = c.history[c.history.length - 1];
      const nextHistory = c.history.slice(0, -1);
      let nextDeletions = c.deletedSpots;
      let nextColorings = c.coloredSpots;

      if (lastAction.type === 'delete') {
        nextDeletions = c.deletedSpots.slice(0, -1);
      } else if (lastAction.type === 'color') {
        nextColorings = c.coloredSpots.slice(0, -1);
      }

      updateCloudShaderStyle(c.tileset, c.color, nextDeletions, nextColorings);

      return {
        ...c,
        deletedSpots: nextDeletions,
        coloredSpots: nextColorings,
        history: nextHistory
      };
    }));

    setStatusMsg(`[${activeCloud.name}] Действие отменено`);
  };

  // Сброс всех правок активного облака
  const handleResetAll = () => {
    const activeCloud = clouds.find(c => c.id === activeCloudId) || clouds[0];
    if (!activeCloud) return;

    setClouds(prev => prev.map(c => {
      if (c.id !== activeCloud.id) return c;
      updateCloudShaderStyle(c.tileset, c.color, [], []);
      return {
        ...c,
        deletedSpots: [],
        coloredSpots: [],
        history: []
      };
    }));

    setStatusMsg(`[${activeCloud.name}] Все правки сброшены`);
  };

  const renameCloud = (id, newName) => {
    setClouds(prev => prev.map(c => c.id === id ? { ...c, name: newName } : c));
  };

  const setCloudHeightOffset = (tileset, offsetMeters) => {
    if (!tileset) return;
    const cartographic = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
    const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0.0);
    const offset = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, offsetMeters);
    const translation = Cesium.Cartesian3.subtract(offset, surface, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsLoading(true);
    setStatusMsg("Отправка файла...");

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
      pollStatus(data.task_id, file.name);
    } catch (err) {
      setStatusMsg("Ошибка: " + err.message);
      setIsLoading(false);
    }
  };

  const pollStatus = (taskId, fileName) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("http://localhost:8000/api/clouds/status/" + taskId);
        const data = await res.json();

        if (data.status === "processing") {
          setStatusMsg(data.message);
        } else if (data.status === "success") {
          clearInterval(interval);
          setStatusMsg("Отрисовка в сцене...");
          await addCloudToScene(taskId, fileName, data.tileset_url, data.point_count || 0);
        } else if (data.status === "failed") {
          clearInterval(interval);
          setStatusMsg("Сбой: " + data.message);
          setIsLoading(false);
        }
      } catch (err) {
        clearInterval(interval);
        setStatusMsg("Сбой связи с сервером");
        setIsLoading(false);
      }
    }, 2000);
  };

  const addCloudToScene = async (id, name, tilesetUrl, pointCount) => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
        maximumScreenSpaceError: 16,
      });

      const color = DEFAULT_COLORS[clouds.length % DEFAULT_COLORS.length];
      tileset.style = new Cesium.Cesium3DTileStyle({
        pointSize: 3.5,
        color: `color("${color}")`
      });

      viewer.scene.primitives.add(tileset);

      const newCloud = {
        id,
        name,
        tileset,
        visible: true,
        color,
        pointCount,
        heightOffset: 0,
        url: tilesetUrl,
        deletedSpots: [],
        coloredSpots: [],
        history: []
      };

      setClouds(prev => [...prev, newCloud]);
      setActiveCloudId(id); // Делаем новое облако сразу активным для правки
      setIsLoading(false);
      setStatusMsg(`Облако «${name}» добавлено и выбрано!`);
      zoomToCloud(tileset);
      setFile(null);
    } catch (error) {
      setStatusMsg("Ошибка рендера: " + error);
      setIsLoading(false);
    }
  };

  const toggleVisibility = (id) => {
    setClouds(prev => prev.map(c => {
      if (c.id === id) {
        const nextVisible = !c.visible;
        c.tileset.show = nextVisible;
        return { ...c, visible: nextVisible };
      }
      return c;
    }));
  };

  const changeColor = (id, newColor) => {
    setClouds(prev => prev.map(c => {
      if (c.id === id) {
        updateCloudShaderStyle(c.tileset, newColor, c.deletedSpots, c.coloredSpots);
        return { ...c, color: newColor };
      }
      return c;
    }));
  };

  const changeHeight = (id, newHeight) => {
    const val = parseFloat(newHeight) || 0;
    setClouds(prev => prev.map(c => {
      if (c.id === id) {
        setCloudHeightOffset(c.tileset, val);
        return { ...c, heightOffset: val };
      }
      return c;
    }));
  };

  const removeCloud = (id) => {
    const cloudToRemove = clouds.find(c => c.id === id);
    if (cloudToRemove && viewerRef.current) {
      viewerRef.current.scene.primitives.remove(cloudToRemove.tileset);
    }
    const remaining = clouds.filter(c => c.id !== id);
    setClouds(remaining);
    if (activeCloudId === id && remaining.length > 0) {
      setActiveCloudId(remaining[0].id);
    }
  };

  const zoomToCloud = (tileset) => {
    if (viewerRef.current && tileset) {
      viewerRef.current.zoomTo(tileset, new Cesium.HeadingPitchRange(0, -0.6, 0));
    }
  };

  const totalVisiblePoints = clouds.reduce((sum, c) => sum + (c.visible ? c.pointCount : 0), 0);
  const activeCloud = clouds.find(c => c.id === activeCloudId) || clouds[0];

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
      <div ref={cesiumContainer} style={{ width: '100%', height: '100%' }} />

      <div style={{
        position: 'absolute', top: 20, left: 20, width: '380px',
        background: 'rgba(255, 255, 255, 0.96)', padding: '16px', borderRadius: '10px',
        zIndex: 999, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', fontFamily: 'system-ui, sans-serif'
      }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', color: '#111' }}>
          ☁️ Управление облаками точек
        </h3>

        <div style={{ background: '#e9ecef', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', color: '#333', marginBottom: '12px' }}>
          📊 Всего точек в сцене: {totalVisiblePoints.toLocaleString('ru-RU')}
        </div>

        {/* Загрузка */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '12px', borderBottom: '1px solid #ddd' }}>
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
              padding: '8px', 
              cursor: file && !isLoading ? 'pointer' : 'not-allowed', 
              background: '#007bff', color: '#fff', border: 'none', borderRadius: '5px', fontWeight: 'bold' 
            }}
          >
            {isLoading ? "Обработка..." : "Загрузить новое облако"}
          </button>
        </div>

        {/* Инструмент правки точек */}
        <div style={{ padding: '12px 0', borderBottom: '1px solid #ddd' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div>
              <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Правка точек: </span>
              {activeCloud && (
                <span style={{ fontSize: '11px', color: '#007bff', fontWeight: 'bold' }}>
                  ({activeCloud.name})
                </span>
              )}
            </div>
            <button
              onClick={() => setEditMode(!editMode)}
              style={{
                padding: '4px 10px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                fontWeight: 'bold', fontSize: '12px', background: editMode ? '#dc3545' : '#28a745', color: '#fff'
              }}
            >
              {editMode ? "Выключить" : "Включить"}
            </button>
          </div>

          {editMode && (
            <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid #e9ecef' }}>
              
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => setSelectionMode('single')}
                  style={{
                    flex: 1, padding: '5px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                    fontWeight: selectionMode === 'single' ? 'bold' : 'normal',
                    background: selectionMode === 'single' ? '#007bff' : '#dee2e6',
                    color: selectionMode === 'single' ? '#fff' : '#333'
                  }}
                >
                  🎯 По 1 точке
                </button>
                <button
                  onClick={() => setSelectionMode('brush')}
                  style={{
                    flex: 1, padding: '5px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                    fontWeight: selectionMode === 'brush' ? 'bold' : 'normal',
                    background: selectionMode === 'brush' ? '#007bff' : '#dee2e6',
                    color: selectionMode === 'brush' ? '#fff' : '#333'
                  }}
                >
                  🖌️ Область (Кисть)
                </button>
              </div>

              <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="radio" name="editAction" value="delete" checked={editAction === 'delete'} onChange={(e) => setEditAction(e.target.value)} />
                  🗑️ Удалять
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input type="radio" name="editAction" value="color" checked={editAction === 'color'} onChange={(e) => setEditAction(e.target.value)} />
                  🎨 Красить
                </label>
              </div>

              {selectionMode === 'brush' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#444' }}>
                  <span>Радиус:</span>
                  <input 
                    type="range" min="1.0" max="15.0" step="1.0" 
                    value={brushRadius} onChange={(e) => setBrushRadius(parseFloat(e.target.value))} 
                    style={{ flex: 1, cursor: 'pointer' }}
                  />
                  <span style={{ minWidth: '30px' }}>{brushRadius}м</span>
                </div>
              )}

              {editAction === 'color' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                  <span>Цвет:</span>
                  <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </div>
              )}

              {/* Кнопки Undo / Сброс конкретно для активного облака */}
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <button
                  onClick={handleUndo}
                  disabled={!activeCloud || activeCloud.history.length === 0}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid #ccc',
                    background: activeCloud && activeCloud.history.length > 0 ? '#ffc107' : '#e9ecef',
                    cursor: activeCloud && activeCloud.history.length > 0 ? 'pointer' : 'not-allowed'
                  }}
                >
                  ↩️ Отменить ({activeCloud ? activeCloud.history.length : 0})
                </button>
                <button
                  onClick={handleResetAll}
                  disabled={!activeCloud || activeCloud.history.length === 0}
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: '11px', borderRadius: '4px', border: '1px solid #ccc',
                    background: activeCloud && activeCloud.history.length > 0 ? '#fff' : '#e9ecef',
                    cursor: activeCloud && activeCloud.history.length > 0 ? 'pointer' : 'not-allowed'
                  }}
                >
                  🔄 Сбросить
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Список слоёв: ТЕПЕРЬ С ВЫБОРОМ АКТИВНОГО ОБЛАКА ДЛЯ ПРАВКИ */}
        <div style={{ marginTop: '12px' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#333' }}>
            Слои ({clouds.length}) — выберите для правки:
          </h4>

          {clouds.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#888', fontStyle: 'italic' }}>
              Нет загруженных облаков
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
              {clouds.map((cloud) => {
                const isActive = cloud.id === activeCloudId;
                return (
                  <div 
                    key={cloud.id} 
                    onClick={() => setActiveCloudId(cloud.id)}
                    style={{ 
                      display: 'flex', flexDirection: 'column', gap: '4px',
                      padding: '8px', borderRadius: '6px', cursor: 'pointer',
                      background: isActive ? '#e7f1ff' : '#f8f9fa',
                      border: isActive ? '2px solid #007bff' : '1px solid #eee'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <input 
                        type="checkbox" 
                        checked={cloud.visible} 
                        onChange={(e) => { e.stopPropagation(); toggleVisibility(cloud.id); }} 
                        title="Показать / скрыть"
                        style={{ cursor: 'pointer' }}
                      />

                      <div style={{ flex: 1, margin: '0 6px', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input 
                            type="text" 
                            value={cloud.name} 
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => renameCloud(cloud.id, e.target.value)} 
                            title="Кликните для переименования"
                            style={{ flex: 1, fontSize: '12px', fontWeight: 'bold', border: 'none', background: 'transparent' }}
                          />
                          {isActive && (
                            <span style={{ fontSize: '10px', background: '#007bff', color: '#fff', padding: '1px 4px', borderRadius: '3px' }}>
                              Активно
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: '#666' }}>
                          Точек: <b>{cloud.pointCount.toLocaleString('ru-RU')}</b>
                        </div>
                      </div>

                      <input 
                        type="color" 
                        value={cloud.color} 
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => changeColor(cloud.id, e.target.value)} 
                        title="Базовый цвет облака"
                        style={{ width: '20px', height: '20px', border: 'none', cursor: 'pointer', background: 'transparent', marginRight: '4px' }}
                      />

                      <button onClick={(e) => { e.stopPropagation(); zoomToCloud(cloud.tileset); }} title="Прилететь к облаку" style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '13px' }}>
                        🎯
                      </button>

                      <button onClick={(e) => { e.stopPropagation(); removeCloud(cloud.id); }} title="Удалить" style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '13px', color: '#dc3545' }}>
                        ❌
                      </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#555', marginTop: '2px' }} onClick={(e) => e.stopPropagation()}>
                      <span>Смещение Z:</span>
                      <input 
                        type="range" 
                        min="-200" 
                        max="200" 
                        step="5" 
                        value={cloud.heightOffset} 
                        onChange={(e) => changeHeight(cloud.id, e.target.value)} 
                        style={{ flex: 1, cursor: 'pointer' }}
                      />
                      <span style={{ minWidth: '35px', textAlign: 'right' }}>{cloud.heightOffset}м</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {statusMsg && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#007bff', fontWeight: '500' }}>
            {statusMsg}
          </div>
        )}
      </div>
    </div>
  );
}