/**
 * Módulo de Exportación e Interoperabilidad (GeoJSON, CSV, KML)
 */

const Exporter = {
  /**
   * Genera especificación GeoJSON completa
   */
  toGeoJSON(blobs, metadata = {}) {
    const features = blobs.map(b => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [b.lon, b.lat]
      },
      properties: {
        id: b.id,
        area_m2: b.areaM2,
        diametro_estimado_m: b.diameterM,
        ndvi_medio: b.meanNdvi,
        estado: b.status,
        confianza: b.confidence,
        pixel_x: b.pixelX,
        pixel_y: b.pixelY,
        fuente_imagen: 'IGN PNOA-IRC (Falso Color Infrarrojo)',
        municipio: 'Gijón (Asturias)',
        fecha_deteccion: new Date().toISOString().split('T')[0]
      }
    }));

    return {
      type: 'FeatureCollection',
      name: 'alcorques_detectados_gijon_pnoa',
      crs: {
        type: 'name',
        properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' }
      },
      metadata: {
        total_alcorques: blobs.length,
        generado_por: 'Alcorques PNOA Gijón Detector PoC',
        ...metadata
      },
      features
    };
  },

  /**
   * Genera archivo CSV
   */
  toCSV(blobs) {
    const headers = ['ID', 'Latitud', 'Longitud', 'Area_m2', 'Diametro_m', 'NDVI_Medio', 'Estado', 'Confianza'];
    const rows = blobs.map(b => [
      b.id,
      b.lat,
      b.lon,
      b.areaM2,
      b.diameterM,
      b.meanNdvi,
      `"${b.status}"`,
      b.confidence
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  },

  /**
   * Descarga un archivo en el navegador
   */
  downloadFile(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Exporter };
}
