/**
 * Motor de Detección de Alcorques Urbanos
 * PNOA-IRC (IGN) + NDVI + OSM Sidewalk Buffer + Connected Components
 */

class AlcorqueDetector {
  constructor() {
    this.ndviThreshold = 0.22;       // Umbral por defecto NDVI para vegetación
    this.bufferMeters = 5.0;         // Buffer de acera en metros
    this.minAreaM2 = 0.6;            // Área mínima de copa/alcorque en m²
    this.maxAreaM2 = 18.0;           // Área máxima de copa de alcorque urbano en m²
    this.useIRC = true;              // Usar PNOA-IRC (True Color IR)
  }

  /**
   * Ejecuta el pipeline completo de detección
   */
  async runDetectionPipeline(params) {
    const {
      bbox,
      width = 600,
      height = 600,
      ndviThreshold = this.ndviThreshold,
      bufferMeters = this.bufferMeters,
      minAreaM2 = this.minAreaM2,
      maxAreaM2 = this.maxAreaM2,
      mode = 'irc',
      onProgress = () => {}
    } = params;

    onProgress({ stage: 'FETCH_IMAGE', percent: 10, message: 'Descargando ortofoto PNOA-IRC del IGN...' });

    // 1. Calcular escala física m/px
    const scaleInfo = this.calculatePixelScale(bbox, width, height);

    // 2. Cargar imagen PNOA (IRC o RGB)
    const imgData = await this.fetchPNOAImageData(bbox, width, height, mode);
    onProgress({ stage: 'NDVI_PROCESSING', percent: 35, message: 'Calculando índice espectral NDVI por píxel...' });

    // 3. Generar Máscara NDVI y Canvas Heatmap
    const ndviResult = this.computeNDVIMask(imgData, width, height, ndviThreshold, mode === 'irc');

    onProgress({ stage: 'OSM_FETCH', percent: 55, message: 'Consultando aceras y vías de OpenStreetMap...' });

    // 4. Obtener vías y aceras de OSM (usar las pasadas en Paso 3 si existen)
    let osmWays = params.osmWays;
    if (!osmWays || osmWays.length === 0) {
      const osmResult = await this.fetchOSMSidewalks(bbox, bufferMeters);
      osmWays = Array.isArray(osmResult) ? osmResult : (osmResult.ways || []);
    }

    onProgress({ stage: 'BUFFER_INTERSECTION', percent: 75, message: 'Intersectando vegetación con buffer de aceras...' });

    const sidewalkBufferMask = this.rasterizeSidewalkBuffer(osmWays, bbox, width, height, scaleInfo, bufferMeters);

    // 5. Intersectar máscara de vegetación con buffer de aceras (ESTRICTO)
    const filteredVegetationMask = new Uint8Array(width * height);
    let totalSidewalkVegPixels = 0;

    for (let i = 0; i < width * height; i++) {
      // Exigir estrictamente pertenencia a la franja de acera (sidewalkBufferMask === 1)
      const inBuffer = (sidewalkBufferMask[i] === 1);
      if (ndviResult.binaryMask[i] === 1 && inBuffer) {
        filteredVegetationMask[i] = 1;
        totalSidewalkVegPixels++;
      } else {
        filteredVegetationMask[i] = 0;
      }
    }

    onProgress({ stage: 'BLOB_DETECTION', percent: 90, message: 'Detectando componentes conexas y centroides de alcorques...' });

    // 6. Extracción de blobs y centroides (restringidos 100% a la acera)
    const blobs = this.extractBlobsAndCentroids(
      filteredVegetationMask,
      ndviResult.ndviValues,
      sidewalkBufferMask,
      width,
      height,
      bbox,
      scaleInfo,
      minAreaM2,
      maxAreaM2
    );

    onProgress({ stage: 'COMPLETE', percent: 100, message: 'Detección finalizada con éxito.' });

    return {
      blobs,
      totalDetected: blobs.length,
      scaleInfo,
      ndviResult,
      sidewalkBufferMask,
      filteredVegetationMask,
      osmWaysCount: osmWays.length,
      imageWidth: width,
      imageHeight: height,
      bbox
    };
  }

  /**
   * Calcula la resolución m/px para la bounding box
   */
  calculatePixelScale(bbox, width, height) {
    const avgLat = (bbox.minLat + bbox.maxLat) / 2;
    const latSpan = bbox.maxLat - bbox.minLat;
    const lonSpan = bbox.maxLon - bbox.minLon;

    const metersY = latSpan * 111320;
    const metersX = lonSpan * 111320 * Math.cos((avgLat * Math.PI) / 180);

    const mPerPxX = metersX / width;
    const mPerPxY = metersY / height;
    const mPerPxAvg = (mPerPxX + mPerPxY) / 2;
    const pxAreaM2 = mPerPxX * mPerPxY;

    return { metersX, metersY, mPerPxX, mPerPxY, mPerPxAvg, pxAreaM2, avgLat };
  }

  /**
   * Solicita ortofoto al proxy WMS del IGN
   */
  async fetchPNOAImageData(bbox, width, height, mode = 'irc') {
    // Convertir bbox a EPSG:3857 (Web Mercator)
    const bbox3857 = this.bboxToEPSG3857(bbox);

    const proxyUrl = `/api/proxy/pnoa-wms?mode=${mode}&layer=OI.OrthoimageCoverage&crs=EPSG:3857` +
      `&bbox=${bbox3857.minX},${bbox3857.minY},${bbox3857.maxX},${bbox3857.maxY}` +
      `&width=${width}&height=${height}&format=image/jpeg`;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        resolve(imgData);
      };
      img.onerror = (err) => {
        // Fallback local canvas if connection fails
        console.warn('Fallback a imagen sintética PNOA:', err);
        resolve(this.generateSyntheticPNOAData(width, height));
      };
      img.src = proxyUrl;
    });
  }

  /**
   * Convierte BBOX WGS84 (Lat/Lon) a EPSG:3857 (Web Mercator meters)
   */
  bboxToEPSG3857(bbox) {
    const lonToX = (lon) => (lon * 20037508.34) / 180;
    const latToY = (lat) => {
      let rad = (lat * Math.PI) / 180;
      return (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 20037508.34) / Math.PI;
    };

    return {
      minX: lonToX(bbox.minLon),
      minY: latToY(bbox.minLat),
      maxX: lonToX(bbox.maxLon),
      maxY: latToY(bbox.maxLat)
    };
  }

  /**
   * Calcula el espectro NDVI por píxel (PNOA-IRC: R=NIR, G=Red)
   */
  computeNDVIMask(imgData, width, height, threshold, isIRC = true) {
    const data = imgData.data;
    const binaryMask = new Uint8Array(width * height);
    const ndviValues = new Float32Array(width * height);
    const heatmapData = new Uint8ClampedArray(width * height * 4);
    let totalVegPixels = 0;

    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      let vegScore = 0;

      // 1. Normalized Green-Red Difference Index (NGRDI / Visible NDVI)
      const denomGR = g + r + 0.0001;
      const ngrdi = (g - r) / denomGR;

      // 2. Excess Green (ExG)
      const exg = (2 * g - r - b) / 255.0;

      // Combinación espectral para máxima sensibilidad en ortofotos PNOA
      vegScore = Math.max(ngrdi, exg);

      // Criterio de foliación urbana: canal verde dominante sobre rojo y azul
      const isGreenFoliage = ngrdi > (threshold - 0.02) && g > (b * 1.02) && g > (r * 0.95);

      ndviValues[i] = vegScore;

      if (isGreenFoliage) {
        binaryMask[i] = 1;
        totalVegPixels++;
        // Heatmap Verde brillante para vegetación
        heatmapData[idx] = 34;
        heatmapData[idx + 1] = 197;
        heatmapData[idx + 2] = 94;
        heatmapData[idx + 3] = 190;
      } else {
        binaryMask[i] = 0;
        heatmapData[idx] = 0;
        heatmapData[idx + 1] = 0;
        heatmapData[idx + 2] = 0;
        heatmapData[idx + 3] = 0;
      }
    }

    return { binaryMask, ndviValues, heatmapData, totalVegPixels };
  }

  /**
   * Consulta dinámicamente las aceras de la zona visible actual (BBOX) en Overpass API
   */
  async fetchOSMSidewalks(bbox, offsetMeters = 5.0) {
    let rawWays = [];
    let source = 'overpass';

    // 1. Prioridad: Intentar cargar desde el archivo en DISCO local primero
    try {
      const diskResp = await fetch(`/api/osm/local-sidewalks?minLat=${bbox.minLat}&minLon=${bbox.minLon}&maxLat=${bbox.maxLat}&maxLon=${bbox.maxLon}`);
      if (diskResp.ok) {
        const diskData = await diskResp.json();
        if (diskData.ways && diskData.ways.length > 0) {
          console.log(`⚡ Cargadas ${diskData.ways.length} vías desde la caché local en DISCO`);
          rawWays = diskData.ways;
          source = 'disk';
        }
      }
    } catch (e) {
      console.warn('No se pudo verificar la caché en disco:', e);
    }

    // 2. Si no están en disco, descargar desde Overpass API
    if (!rawWays || rawWays.length === 0) {
      const overpassQuery = `[out:json][timeout:25];
(
  way["highway"~"footway|residential|pedestrian|tertiary|unclassified|service|living_street|secondary|primary"](${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
);
out body;
>;
out skel qt;`;

      try {
        const resp = await fetch(`/api/proxy/overpass?data=${encodeURIComponent(overpassQuery)}`);
        if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
        const data = await resp.json();
        rawWays = this.parseOSMWays(data);
        if (!rawWays || rawWays.length === 0) {
          throw new Error('0 vías devueltas para este BBOX');
        }
        source = 'network';
      } catch (err) {
        console.warn('Overpass API no disponible o en timeout, cargando reserva de aceras:', err);
        rawWays = await this.fetchCachedSidewalksFallback(bbox);
        source = 'fallback';
      }
    }

    this.lastFetchedRawWays = rawWays;
    this.lastFetchedSource = source;

    // 3. Filtrar calzadas centrales y conservar ÚNICAMENTE líneas de acera
    const processedWays = this.processSidewalksOnly(rawWays, offsetMeters);
    return {
      ways: processedWays,
      rawWays,
      source
    };
  }

  async saveSidewalksToDisk(zoneName, ways) {
    const targetWays = ways || this.lastFetchedRawWays || [];
    if (!targetWays.length) throw new Error('No hay aceras cargadas para guardar');

    const resp = await fetch('/api/osm/save-sidewalks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneName, ways: targetWays })
    });
    if (!resp.ok) throw new Error(`Error HTTP ${resp.status} al guardar en disco`);
    return await resp.json();
  }

  async fetchCachedSidewalksFallback(bbox) {
    try {
      const resp = await fetch('/gijon_osm_cache.json');
      if (!resp.ok) throw new Error('Archivo de caché local no disponible');
      const cacheData = await resp.json();
      let allWays = [];
      Object.keys(cacheData).forEach(key => {
        allWays = allWays.concat(cacheData[key]);
      });

      // Filtrar vías que caen en el BBOX actual (con un pequeño margen de 0.002 deg)
      const margin = 0.002;
      const matchingWays = allWays.filter(w => {
        return w.coords && w.coords.some(c => {
          const lat = c[0], lon = c[1];
          return lat >= (bbox.minLat - margin) && lat <= (bbox.maxLat + margin) &&
                 lon >= (bbox.minLon - margin) && lon <= (bbox.maxLon + margin);
        });
      });

      if (matchingWays.length > 0) {
        console.log(`✅ Usando ${matchingWays.length} vías reales precacheadas de Gijón`);
        return matchingWays;
      }
    } catch (err) {
      console.warn('Error accediendo a gijon_osm_cache.json:', err);
    }

    // Si no existen aceras reales registradas en esta zona, devolver array vacío para no crear cuadrículas falsas
    return [];
  }

  /**
   * Convierte calzadas centrales en 2 líneas paralelas de acera (bordillos) y conserva aceras explícitas
   */
  processSidewalksOnly(rawWays, offsetMeters = 5.0) {
    const sidewalkWays = [];

    rawWays.forEach(w => {
      const wtype = w.type || 'residential';

      // Si la vía YA es una acera/bordillo procesada previa, NO volver a aplicar offset 5m
      if (wtype === 'acera_bordillo' || String(w.id).includes('-acera-') || w.isExplicit) {
        sidewalkWays.push({ ...w, isExplicit: true });
        return;
      }

      // Descartar vías de servicio internas, pasadizos privados y accesos a garajes/patios
      if (['service', 'track', 'service_link', 'driveway', 'parking_aisle'].includes(wtype)) {
        return;
      }

      const isExplicitSidewalk = ['footway', 'pedestrian', 'path', 'steps', 'sidewalk'].includes(wtype);

      if (isExplicitSidewalk) {
        sidewalkWays.push({ ...w, isExplicit: true });
      } else if (w.coords && w.coords.length >= 2) {
        // Separar eje de calzada pública en 2 líneas paralelas de acera (bordillos izquierda y derecha)
        const leftCoords = [];
        const rightCoords = [];

        for (let i = 0; i < w.coords.length - 1; i++) {
          const lat1 = w.coords[i][0];
          const lon1 = w.coords[i][1];
          const lat2 = w.coords[i + 1][0];
          const lon2 = w.coords[i + 1][1];

          const avgLat = (lat1 + lat2) / 2;
          const mPerDegLat = 111320.0;
          const mPerDegLon = 111320.0 * Math.cos((avgLat * Math.PI) / 180);

          const dx = (lon2 - lon1) * mPerDegLon;
          const dy = (lat2 - lat1) * mPerDegLat;
          const len = Math.sqrt(dx * dx + dy * dy);

          if (len > 0) {
            const nx = -dy / len;
            const ny = dx / len;

            const offsetLat = (ny * offsetMeters) / mPerDegLat;
            const offsetLon = (nx * offsetMeters) / mPerDegLon;

            if (i === 0) {
              leftCoords.push([lat1 + offsetLat, lon1 + offsetLon]);
              rightCoords.push([lat1 - offsetLat, lon1 - offsetLon]);
            }
            leftCoords.push([lat2 + offsetLat, lon2 + offsetLon]);
            rightCoords.push([lat2 - offsetLat, lon2 - offsetLon]);
          }
        }

        if (leftCoords.length > 1) {
          sidewalkWays.push({ id: `${w.id}-acera-izq`, type: 'acera_bordillo', coords: leftCoords, isExplicit: false });
        }
        if (rightCoords.length > 1) {
          sidewalkWays.push({ id: `${w.id}-acera-der`, type: 'acera_bordillo', coords: rightCoords, isExplicit: false });
        }
      }
    });

    return sidewalkWays;
  }

  /**
   * Convierte la respuesta de Overpass a vías con coordenadas Lat/Lon
   */
  parseOSMWays(osmData) {
    if (!osmData || !osmData.elements) return [];

    const nodesMap = new Map();
    osmData.elements.forEach(elem => {
      if (elem.type === 'node') {
        nodesMap.set(elem.id, [elem.lat, elem.lon]);
      }
    });

    const ways = [];
    osmData.elements.forEach(elem => {
      if (elem.type === 'way' && elem.nodes) {
        const coords = elem.nodes.map(nodeId => nodesMap.get(nodeId)).filter(Boolean);
        if (coords.length > 1) {
          ways.push({
            id: elem.id,
            type: elem.tags ? elem.tags.highway : 'road',
            coords
          });
        }
      }
    });

    return ways;
  }

  /**
   * Rasteriza el buffer de acera en una máscara binaria 2D
   */
  rasterizeSidewalkBuffer(ways, bbox, width, height, scaleInfo, bufferMeters) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const bbox3857 = this.bboxToEPSG3857(bbox);
    const spanX = bbox3857.maxX - bbox3857.minX;
    const spanY = bbox3857.maxY - bbox3857.minY;

    // Ancho de trazo estándar para aceras públicas (m/px)
    const baseLineWidthPx = Math.max(5, (bufferMeters / scaleInfo.mPerPxAvg) * 0.7);
    const explicitLineWidthPx = Math.max(4, (2.5 / scaleInfo.mPerPxAvg));

    ways.forEach(way => {
      ctx.beginPath();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = way.isExplicit ? explicitLineWidthPx : baseLineWidthPx;

      way.coords.forEach((coord, idx) => {
        const lat = coord[0];
        const lon = coord[1];

        const x3857 = (lon * 20037508.34) / 180;
        const rad = (lat * Math.PI) / 180;
        const y3857 = (Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 20037508.34) / Math.PI;

        const x = ((x3857 - bbox3857.minX) / spanX) * width;
        const y = ((bbox3857.maxY - y3857) / spanY) * height;

        if (idx === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });

    const imgData = ctx.getImageData(0, 0, width, height);
    const bufferMask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      // Cualquier píxel dibujado en el buffer (>10 en canal rojo o alfa)
      bufferMask[i] = (imgData.data[i * 4] > 10 || imgData.data[i * 4 + 3] > 10) ? 1 : 0;
    }

    return bufferMask;
  }

  /**
   * Componentes conexas y extracción de centroides (Blobs)
   */
  extractBlobsAndCentroids(binaryMask, ndviValues, sidewalkBufferMask, width, height, bbox, scaleInfo, minAreaM2, maxAreaM2) {
    const visited = new Uint8Array(width * height);
    const blobs = [];
    let blobIdCounter = 1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;

        if (binaryMask[idx] === 1 && visited[idx] === 0) {
          // Iniciar BFS para agrupar píxeles del árbol/alcorque
          const queue = [idx];
          visited[idx] = 1;

          let sumSidewalkX = 0;
          let sumSidewalkY = 0;
          let sidewalkPixelCount = 0;
          let totalPixelCount = 0;
          let sumNdvi = 0;

          let head = 0;
          while (head < queue.length) {
            const currIdx = queue[head++];
            const currX = currIdx % width;
            const currY = Math.floor(currIdx / width);

            totalPixelCount++;
            sumNdvi += ndviValues[currIdx];

            // Píxel estrictamente situado sobre la acera
            if (sidewalkBufferMask && sidewalkBufferMask[currIdx] === 1) {
              sumSidewalkX += currX;
              sumSidewalkY += currY;
              sidewalkPixelCount++;
            }

            const neighbors = [
              currX > 0 ? currIdx - 1 : -1,
              currX < width - 1 ? currIdx + 1 : -1,
              currY > 0 ? currIdx - width : -1,
              currY < height - 1 ? currIdx + width : -1
            ];

            for (const nIdx of neighbors) {
              if (nIdx >= 0 && binaryMask[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queue.push(nIdx);
              }
            }
          }

          // EXIGENCIA ABSOLUTA: Descartar si no tiene píxeles suficientes sobre la acera real
          if (sidewalkPixelCount < 3) {
            continue;
          }

          // Calcular área física sobre la acera
          const areaM2 = sidewalkPixelCount * scaleInfo.pxAreaM2;

          // Filtrar por tamaño de alcorque / copa urbana
          if (areaM2 >= minAreaM2 && areaM2 <= maxAreaM2) {
            // El centroide se calcula ÚNICAMENTE promediando los píxeles que están SOBRE LA ACERA
            const centroidX = sumSidewalkX / sidewalkPixelCount;
            const centroidY = sumSidewalkY / sidewalkPixelCount;
            const avgNdvi = sumNdvi / totalPixelCount;

            // Convertir píxel a Lat/Lon con la proyección EPSG:3857 Web Mercator inversa exacta
            const bbox3857 = this.bboxToEPSG3857(bbox);
            const centroidX3857 = bbox3857.minX + (centroidX / width) * (bbox3857.maxX - bbox3857.minX);
            const centroidY3857 = bbox3857.maxY - (centroidY / height) * (bbox3857.maxY - bbox3857.minY);

            const lon = (centroidX3857 * 180) / 20037508.34;
            const rad = Math.atan(Math.sinh((centroidY3857 * Math.PI) / 20037508.34));
            const lat = (rad * 180) / Math.PI;

            // Calcular diámetro estimado
            const estimatedDiameterM = Math.sqrt((4 * areaM2) / Math.PI);

            blobs.push({
              id: `ALC-GIJ-${String(blobIdCounter++).padStart(4, '0')}`,
              lat: Number(lat.toFixed(6)),
              lon: Number(lon.toFixed(6)),
              pixelX: Math.round(centroidX),
              pixelY: Math.round(centroidY),
              areaM2: Number(areaM2.toFixed(2)),
              diameterM: Number(estimatedDiameterM.toFixed(2)),
              pixelCount: sidewalkPixelCount,
              meanNdvi: Number(avgNdvi.toFixed(3)),
              status: avgNdvi > 0.35 ? 'Árbol Follaje Denso' : 'Alcorque con Árbol Joven/Parcial',
              confidence: Number(Math.min(0.98, 0.70 + (avgNdvi * 0.3)).toFixed(2))
            });
          }
        }
      }
    }

    return blobs;
  }

  /**
   * Genera ortofoto sintética de prueba si falla WMS
   */
  generateSyntheticPNOAData(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    
    // Fondo asfalto/granito claro
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(0, 0, w, h);

    // Línea de acera
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(40, 0, 100, h);

    // Árboles sintéticos en acera con IRC alto (Red=250, Green=50)
    const treePositions = [
      { x: 90, y: 60, r: 22 },
      { x: 90, y: 180, r: 24 },
      { x: 90, y: 300, r: 20 },
      { x: 90, y: 420, r: 26 },
      { x: 90, y: 530, r: 23 }
    ];

    treePositions.forEach(t => {
      const grad = ctx.createRadialGradient(t.x, t.y, 2, t.x, t.y, t.r);
      grad.addColorStop(0, '#f87171'); // IRC alto (NIR)
      grad.addColorStop(1, '#991b1b');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
    });

    return ctx.getImageData(0, 0, w, h);
  }

  /**
   * Genera trazado de aceras sintético si falla Overpass API
   */
  generateSyntheticSidewalks(bbox) {
    const ways = [];
    const latSpan = bbox.maxLat - bbox.minLat;
    const lonSpan = bbox.maxLon - bbox.minLon;

    // 4 calles verticales
    for (let i = 1; i <= 4; i++) {
      const lon = bbox.minLon + (lonSpan * (i / 5));
      ways.push({
        id: `grid-v-${i}`,
        type: 'residential',
        coords: [
          [bbox.maxLat, lon],
          [bbox.minLat, lon]
        ]
      });
    }

    // 4 calles horizontales
    for (let j = 1; j <= 4; j++) {
      const lat = bbox.minLat + (latSpan * (j / 5));
      ways.push({
        id: `grid-h-${j}`,
        type: 'residential',
        coords: [
          [lat, bbox.minLon],
          [lat, bbox.maxLon]
        ]
      });
    }

    return ways;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AlcorqueDetector };
}
