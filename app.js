/**
 * Controlador Paso a Paso con Inspector Visual HD y Activación Secuencial
 */

document.addEventListener('DOMContentLoaded', () => {
  const detector = new AlcorqueDetector();
  let map;
  let ndviImageOverlay = null;
  let sidewalkLayerGroup = L.layerGroup();
  let alcorquesLayerGroup = L.layerGroup();
  
  let currentOsmWays = [];
  let detectedBlobs = [];
  let currentSelectedBlob = null;
  let rawPnoaImgData = null;

  // 1. Inicializar Mapa (Paso 1)
  initMap();

  // 2. Cargar Presets de Gijón
  initPresets();

  // 3. Hacer el inspector arrastrable
  initDraggableInspector();

  // 3. Eventos Paso 2, 3 y 4
  document.getElementById('btnStepVeg').addEventListener('click', runStep2Vegetation);
  document.getElementById('btnStepOsm').addEventListener('click', runStep3Sidewalks);
  document.getElementById('btnStepPoints').addEventListener('click', runStep4Points);

  // Inspector Buttons
  document.getElementById('btnCloseInspector').addEventListener('click', closeInspector);
  document.getElementById('btnValid').addEventListener('click', () => setValidationStatus('VALIDO'));
  document.getElementById('btnDoubt').addEventListener('click', () => setValidationStatus('DUDA'));
  document.getElementById('btnReject').addEventListener('click', () => setValidationStatus('NO_ES'));
  document.getElementById('btnPrevBlob').addEventListener('click', () => navigateInspector(-1));
  document.getElementById('btnNextBlob').addEventListener('click', () => navigateInspector(1));

  // Export Button
  document.getElementById('btnExportGeoJSON').addEventListener('click', () => {
    if (!detectedBlobs.length) {
      alert('No hay alcorques para exportar.');
      return;
    }
    const geojson = Exporter.toGeoJSON(detectedBlobs, { municipio: 'Gijón' });
    Exporter.downloadFile(JSON.stringify(geojson, null, 2), 'alcorques_gijon_validados.geojson', 'application/json');
  });

  const rngSens = document.getElementById('rngSens');
  const lblSensVal = document.getElementById('lblSensVal');
  rngSens.addEventListener('input', (e) => {
    lblSensVal.textContent = e.target.value;
    if (ndviImageOverlay) {
      runStep2Vegetation();
    }
  });

  const rngBuffer = document.getElementById('rngBuffer');
  const lblBufferVal = document.getElementById('lblBufferVal');
  rngBuffer.addEventListener('input', (e) => {
    lblBufferVal.textContent = `${e.target.value}m`;
    if (currentOsmWays.length > 0) {
      renderSidewalksOnMap(currentOsmWays, parseFloat(e.target.value));
    }
  });

  /**
   * Paso 1: Configuración del Mapa con Ortofoto IGN
   */
  function initMap() {
    const initialCenter = GIJON_PRESETS[0].center; // Paseo de Begoña
    const initialZoom = GIJON_PRESETS[0].zoom;

    map = L.map('map', {
      center: initialCenter,
      zoom: initialZoom,
      maxZoom: 21,
      zoomControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(map);

    // Ortofoto PNOA del IGN (Máxima Actualidad)
    const pnoaMA = L.tileLayer.wms('https://www.ign.es/wms-inspire/pnoa-ma', {
      layers: 'OI.OrthoimageCoverage',
      format: 'image/jpeg',
      transparent: false,
      version: '1.3.0',
      attribution: '&copy; Instituto Geográfico Nacional de España (IGN - PNOA)',
      maxZoom: 21
    }).addTo(map);

    // OpenStreetMap Callejero
    const baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    });

    L.control.layers({
      "Ortofoto PNOA (IGN)": pnoaMA,
      "OpenStreetMap Callejero": baseOSM
    }, {}, { position: 'topright' }).addTo(map);

    sidewalkLayerGroup.addTo(map);
    alcorquesLayerGroup.addTo(map);

    // Nota: Las capas calculadas (NDVI, aceras, alcorques) se conservan al desplazar o hacer zoom en el mapa.
  }

  /**
   * Selector de Presets de Gijón
   */
  function initPresets() {
    const select = document.getElementById('presetSelect');
    GIJON_PRESETS.forEach(preset => {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = `📍 ${preset.name}`;
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      const selected = GIJON_PRESETS.find(p => p.id === e.target.value);
      if (selected) {
        map.setView(selected.center, selected.zoom);
        closeInspector();
        if (ndviImageOverlay) {
          setTimeout(() => runStep2Vegetation(), 400);
        }
      }
    });
  }

  /**
   * PASO 2: Aislamiento de Vegetación (NDVI / NGRDI)
   */
  async function runStep2Vegetation() {
    const bounds = map.getBounds();
    const bbox = {
      minLat: bounds.getSouth(),
      minLon: bounds.getWest(),
      maxLat: bounds.getNorth(),
      maxLon: bounds.getEast()
    };

    const sens = parseFloat(document.getElementById('rngSens').value);

    document.getElementById('lblStepTitle').textContent = '🌱 Paso 2: Procesando vegetación de la ortofoto...';

    try {
      rawPnoaImgData = await detector.fetchPNOAImageData(bbox, 800, 800, 'rgb');
      const maskResult = detector.computeNDVIMask(rawPnoaImgData, 800, 800, sens);
      renderVegetationOverlay(maskResult, bbox, 800, 800);

      // Activar Paso 3
      const btnOsm = document.getElementById('btnStepOsm');
      btnOsm.disabled = false;
      btnOsm.classList.remove('btn-secondary');
      btnOsm.classList.add('btn-primary');
      btnOsm.style.background = 'linear-gradient(135deg, #38bdf8, #0284c7)';
      btnOsm.style.opacity = '1';

    } catch (err) {
      console.error('Error en Paso 2:', err);
    }
  }

  function renderVegetationOverlay(maskResult, bbox, width, height) {
    if (ndviImageOverlay) {
      map.removeLayer(ndviImageOverlay);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(maskResult.heatmapData);
    ctx.putImageData(imgData, 0, 0);

    const imageUrl = canvas.toDataURL();
    const imageBounds = [
      [bbox.minLat, bbox.minLon],
      [bbox.maxLat, bbox.maxLon]
    ];

    ndviImageOverlay = L.imageOverlay(imageUrl, imageBounds, { opacity: 0.75 }).addTo(map);

    document.getElementById('lblStepTitle').textContent = `🌱 Paso 2 Completado: ${maskResult.totalVegPixels.toLocaleString()} píxeles de vegetación`;
    document.getElementById('lblStepDesc').textContent = 'Zonas verdes aisladas. Ahora pulsa "Paso 3: Aceras" para limitar la vegetación a las franjas de calle.';
  }

  /**
   * PASO 3: Cargar y Superponer Aceras
   */
  async function runStep3Sidewalks() {
    const bounds = map.getBounds();
    const bbox = {
      minLat: bounds.getSouth(),
      minLon: bounds.getWest(),
      maxLat: bounds.getNorth(),
      maxLon: bounds.getEast()
    };

    const bufferMeters = parseFloat(document.getElementById('rngBuffer').value);

    document.getElementById('lblStepTitle').textContent = '🛣️ Paso 3: Calculando líneas de acera de OSM...';

    try {
      const result = await detector.fetchOSMSidewalks(bbox, bufferMeters);
      currentOsmWays = result.ways || [];
      renderSidewalksOnMap(currentOsmWays, bufferMeters);

      // Actualizar Widget Flotante de Estado de Disco
      const diskStatusText = document.getElementById('diskStatusText');
      const btnSaveDisk = document.getElementById('btnSaveSidewalksToDisk');

      if (result.source === 'disk') {
        diskStatusText.innerHTML = `⚡ <span style="color:#34d399;">Datos Locales en Disco</span> (${currentOsmWays.length} aceras)`;
        btnSaveDisk.style.display = 'none';
      } else {
        diskStatusText.innerHTML = `🌐 <span style="color:#fbbf24;">Descargado de Red (Overpass)</span> (${currentOsmWays.length} vías)`;
        btnSaveDisk.style.display = 'inline-block';
        btnSaveDisk.textContent = '💾 Guardar Aceras en Disco';
        btnSaveDisk.disabled = false;
      }

      // Activar Paso 4
      const btnPoints = document.getElementById('btnStepPoints');
      btnPoints.disabled = false;
      btnPoints.classList.remove('btn-secondary');
      btnPoints.classList.add('btn-primary');
      btnPoints.style.background = 'linear-gradient(135deg, #a855f7, #7e22ce)';
      btnPoints.style.opacity = '1';

    } catch (err) {
      console.error('Error en Paso 3:', err);
    }
  }

  // Event listener para guardar aceras en disco
  document.getElementById('btnSaveSidewalksToDisk').addEventListener('click', async () => {
    const btnSave = document.getElementById('btnSaveSidewalksToDisk');
    const diskStatusText = document.getElementById('diskStatusText');
    btnSave.textContent = '⏳ Guardando en disco...';
    btnSave.disabled = true;

    try {
      const selectedPreset = document.getElementById('presetSelect').value || 'zona';
      const zoneName = `${selectedPreset}_${Date.now()}`;
      const res = await detector.saveSidewalksToDisk(zoneName);

      diskStatusText.innerHTML = `⚡ <span style="color:#34d399;">Guardado en Disco Exitosamente</span>`;
      btnSave.style.display = 'none';
      alert(`✅ ¡Guardadas ${res.savedWays} vías de acera permanentemente en disco (gijon_osm_cache.json)! A partir de ahora esta zona cargará en 0 ms de forma local.`);
    } catch (err) {
      alert('Error guardando en disco: ' + err.message);
      btnSave.textContent = '💾 Guardar Aceras';
      btnSave.disabled = false;
    }
  });

  // Event listener para borrar/refrescar la caché de aceras
  document.getElementById('btnClearSidewalkCache').addEventListener('click', async () => {
    if (!confirm('¿Seguro que quieres borrar la caché local de aceras y forzar recargas frescas de red?')) return;
    try {
      const resp = await fetch('/api/osm/clear-cache', { method: 'POST' });
      if (!resp.ok) throw new Error('Error al borrar la caché');
      alert('🗑️ Caché de aceras limpia en disco y RAM. Pulsa "Paso 3: Aceras" para volver a descargar datos frescos.');
      document.getElementById('diskStatusText').textContent = 'Caché eliminada. Pulsa Paso 3 para recargar.';
      document.getElementById('btnSaveSidewalksToDisk').style.display = 'none';
      sidewalkLayerGroup.clearLayers();
      currentOsmWays = [];
    } catch (err) {
      alert('Error limpiando caché: ' + err.message);
    }
  });

  function renderSidewalksOnMap(ways, bufferMeters) {
    sidewalkLayerGroup.clearLayers();

    ways.forEach(way => {
      const isExplicit = way.type === 'acera_explicita' || way.type === 'footway' || way.type === 'pedestrian';
      const color = isExplicit ? '#38bdf8' : '#fbbf24';

      const polyline = L.polyline(way.coords, {
        color,
        weight: Math.max(3, bufferMeters * 1.5),
        opacity: 0.7,
        lineCap: 'round',
        lineJoin: 'round'
      });
      sidewalkLayerGroup.addLayer(polyline);
    });

    document.getElementById('lblStepTitle').textContent = `🛣️ Paso 3 Completado: ${ways.length} líneas de acera (bordillos) cargadas`;
    document.getElementById('lblStepDesc').textContent = 'Las líneas muestran las franjas exactas de acera. La calzada central ha sido descartada.';
  }

  /**
   * PASO 4: Intersección, Detección de Alcorques & Visor Inspector HD
   */
  async function runStep4Points() {
    const bounds = map.getBounds();
    const bbox = {
      minLat: bounds.getSouth(),
      minLon: bounds.getWest(),
      maxLat: bounds.getNorth(),
      maxLon: bounds.getEast()
    };

    const sens = parseFloat(document.getElementById('rngSens').value);
    const bufferMeters = parseFloat(document.getElementById('rngBuffer').value);

    document.getElementById('lblStepTitle').textContent = '🎯 Paso 4: Calculando alcorques y preparando inspector HD...';

    try {
      const result = await detector.runDetectionPipeline({
        bbox,
        width: 800,
        height: 800,
        ndviThreshold: sens,
        bufferMeters,
        osmWays: currentOsmWays,
        minAreaM2: 0.2,
        maxAreaM2: 30.0
      });

      detectedBlobs = result.blobs;
      detectedBlobs.forEach(b => {
        b.userStatus = 'PENDIENTE'; // Por defecto PENDIENTE de validación
      });

      renderAlcorquesOnMap(detectedBlobs);
      updateValidationStats();

      document.getElementById('lblStepTitle').textContent = `🎯 Paso 4 Completado: ${detectedBlobs.length} alcorques detectados`;
      document.getElementById('lblStepDesc').textContent = 'Haz clic en cualquier punto o presiona 1/2/3 (o V/D/X) para validar rápidamente cada alcorque.';

      // Abrir el primer alcorque pendiente en el inspector
      if (detectedBlobs.length > 0) {
        openInspectorForBlob(detectedBlobs[0]);
      }

    } catch (err) {
      console.error('Error en Paso 4:', err);
      alert('Error en Paso 4: ' + err.message);
    }
  }

  function renderAlcorquesOnMap(blobs) {
    alcorquesLayerGroup.clearLayers();

    blobs.forEach(b => {
      const isSelected = currentSelectedBlob && currentSelectedBlob.id === b.id;

      if (isSelected) {
        // Halo exterior para el alcorque activo
        const haloMarker = L.circleMarker([b.lat, b.lon], {
          radius: 18,
          fillColor: 'transparent',
          color: '#00f0ff',
          weight: 2,
          dashArray: '5, 5',
          opacity: 1
        });

        // Marcador destacado (Cian Neón 13px al frente de todos)
        const selectedMarker = L.circleMarker([b.lat, b.lon], {
          radius: 13,
          fillColor: '#00f0ff',
          color: '#ffffff',
          weight: 4,
          opacity: 1,
          fillOpacity: 1
        });

        selectedMarker.on('click', () => openInspectorForBlob(b));

        alcorquesLayerGroup.addLayer(haloMarker);
        alcorquesLayerGroup.addLayer(selectedMarker);
        selectedMarker.bringToFront();
      } else {
        let color = '#38bdf8'; // Azul Claro: Pendiente
        if (b.userStatus === 'VALIDO') color = '#34d399'; // Verde: Válido
        if (b.userStatus === 'DUDA') color = '#fbbf24';   // Amarillo: Duda
        if (b.userStatus === 'NO_ES') color = '#f87171';  // Rojo: Descartado

        const marker = L.circleMarker([b.lat, b.lon], {
          radius: 7,
          fillColor: color,
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9
        });

        marker.on('click', () => openInspectorForBlob(b));
        alcorquesLayerGroup.addLayer(marker);
      }
    });
  }

  async function openInspectorForBlob(blob) {
    currentSelectedBlob = blob;
    renderAlcorquesOnMap(detectedBlobs);

    const panel = document.getElementById('inspectorPanel');
    panel.style.display = 'flex';

    document.getElementById('inspId').textContent = blob.id;
    document.getElementById('inspArea').textContent = blob.areaM2;
    document.getElementById('inspNdvi').textContent = blob.meanNdvi;
    document.getElementById('inspCoords').textContent = `${blob.lat}, ${blob.lon}`;

    updateValidationButtonsUI(blob.userStatus);

    const cropBbox = {
      minLat: blob.lat - 0.00006,
      minLon: blob.lon - 0.00008,
      maxLat: blob.lat + 0.00006,
      maxLon: blob.lon + 0.00008
    };

    try {
      const cropData = await detector.fetchPNOAImageData(cropBbox, 220, 220, 'rgb');
      const rgbCanvas = document.getElementById('cropRgbCanvas');
      const rgbCtx = rgbCanvas.getContext('2d');
      rgbCtx.putImageData(cropData, 0, 0);

      rgbCtx.strokeStyle = '#ef4444';
      rgbCtx.lineWidth = 2;
      rgbCtx.beginPath();
      rgbCtx.arc(110, 110, 18, 0, Math.PI * 2);
      rgbCtx.stroke();

      const sens = parseFloat(document.getElementById('rngSens').value);
      const maskResult = detector.computeNDVIMask(cropData, 220, 220, sens);
      const ndviCanvas = document.getElementById('cropNdviCanvas');
      const ndviCtx = ndviCanvas.getContext('2d');
      const maskImgData = ndviCtx.createImageData(220, 220);
      maskImgData.data.set(maskResult.heatmapData);
      ndviCtx.putImageData(maskImgData, 0, 0);

      ndviCtx.strokeStyle = '#38bdf8';
      ndviCtx.lineWidth = 2;
      ndviCtx.beginPath();
      ndviCtx.arc(110, 110, 18, 0, Math.PI * 2);
      ndviCtx.stroke();

    } catch (err) {
      console.error('Error generando recortes HD:', err);
    }
  }

  function setValidationStatus(status, autoAdvance = true) {
    if (!currentSelectedBlob) return;
    currentSelectedBlob.userStatus = status;
    updateValidationButtonsUI(status);
    renderAlcorquesOnMap(detectedBlobs);
    updateValidationStats();

    if (autoAdvance) {
      navigateToNextUncataloged();
    }
  }

  function navigateToNextUncataloged() {
    if (!currentSelectedBlob || !detectedBlobs.length) return;

    const currentIndex = detectedBlobs.findIndex(b => b.id === currentSelectedBlob.id);
    let nextBlob = null;

    // Buscar el siguiente alcorque PENDIENTE a partir del actual
    for (let i = 1; i <= detectedBlobs.length; i++) {
      const idx = (currentIndex + i) % detectedBlobs.length;
      if (detectedBlobs[idx].userStatus === 'PENDIENTE') {
        nextBlob = detectedBlobs[idx];
        break;
      }
    }

    if (nextBlob) {
      openInspectorForBlob(nextBlob);
    } else {
      document.getElementById('lblStepTitle').textContent = '🎉 ¡Todos los alcorques catalogados!';
      document.getElementById('lblStepDesc').textContent = 'Has revisado todos los alcorques de esta zona. Puedes exportar el resultado en GeoJSON.';
      const nextIndex = (currentIndex + 1) % detectedBlobs.length;
      openInspectorForBlob(detectedBlobs[nextIndex]);
    }
  }

  function navigateInspector(direction) {
    if (!currentSelectedBlob || !detectedBlobs.length) return;
    const currentIndex = detectedBlobs.findIndex(b => b.id === currentSelectedBlob.id);
    if (currentIndex === -1) return;
    const nextIndex = (currentIndex + direction + detectedBlobs.length) % detectedBlobs.length;
    openInspectorForBlob(detectedBlobs[nextIndex]);
  }

  function updateValidationButtonsUI(status) {
    document.getElementById('btnValid').classList.toggle('active', status === 'VALIDO');
    document.getElementById('btnDoubt').classList.toggle('active', status === 'DUDA');
    document.getElementById('btnReject').classList.toggle('active', status === 'NO_ES');
  }

  function updateValidationStats() {
    const pending = detectedBlobs.filter(b => b.userStatus === 'PENDIENTE').length;
    const valid = detectedBlobs.filter(b => b.userStatus === 'VALIDO').length;
    const doubt = detectedBlobs.filter(b => b.userStatus === 'DUDA').length;
    const rej = detectedBlobs.filter(b => b.userStatus === 'NO_ES').length;

    const statsElem = document.getElementById('kpiStats');
    if (statsElem) {
      statsElem.innerHTML =
        `<span style="color:#38bdf8;">${pending} Pendientes</span> | ` +
        `<span style="color:#34d399;">${valid} Válidos</span> | ` +
        `<span style="color:#fbbf24;">${doubt} Duda</span> | ` +
        `<span style="color:#f87171;">${rej} Descartados</span>`;
    }
  }

  function closeInspector() {
    document.getElementById('inspectorPanel').style.display = 'none';
    currentSelectedBlob = null;
    renderAlcorquesOnMap(detectedBlobs);
  }

  function initDraggableInspector() {
    const header = document.getElementById('inspectorHeader');
    const panel = document.getElementById('inspectorPanel');
    if (!header || !panel) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#btnCloseInspector')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      panel.style.right = 'auto';
      panel.style.left = `${initialLeft}px`;
      panel.style.top = `${initialTop}px`;

      try { header.setPointerCapture(e.pointerId); } catch(ex) {}
    });

    header.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${initialLeft + dx}px`;
      panel.style.top = `${initialTop + dy}px`;
    });

    const stopDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch(ex) {}
      }
    };

    header.addEventListener('pointerup', stopDrag);
    header.addEventListener('pointercancel', stopDrag);
  }

  // Atajos de teclado para la validación ágil
  document.addEventListener('keydown', (e) => {
    // Si hay un inspector abierto
    const panel = document.getElementById('inspectorPanel');
    if (panel && panel.style.display !== 'none') {
      if (e.key === '1' || e.key.toLowerCase() === 'v') {
        setValidationStatus('VALIDO', true);
      } else if (e.key === '2' || e.key.toLowerCase() === 'd') {
        setValidationStatus('DUDA', true);
      } else if (e.key === '3' || e.key.toLowerCase() === 'x') {
        setValidationStatus('NO_ES', true);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        navigateInspector(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        navigateInspector(-1);
      } else if (e.key === 'Escape') {
        closeInspector();
      }
    }
  });
});
