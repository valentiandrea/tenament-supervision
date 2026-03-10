const xml2js = require('xml2js');
const fs = require('fs');

function parseCoordinates(coordString) {
  const coordinates = [];
  if (!coordString) return coordinates;

  const points = coordString.trim().split(/\s+/);
  for (const point of points) {
    const parts = point.split(',');
    if (parts.length >= 2) {
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lon) && !isNaN(lat)) {
        coordinates.push([lon, lat]);
      }
    }
  }
  return coordinates;
}

function extractFromNode(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return extractFromNode(node[0]);
  if (node && typeof node === 'object') {
    if (node._) return node._;
    return '';
  }
  return '';
}

async function parseKmlFile(filePath, fileName) {
  const tenements = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parser = new xml2js.Parser({
      explicitArray: true,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });

    const result = await parser.parseStringPromise(content);

    // Navigate the KML structure
    const root = result.kml || result.KML || result;
    let placemarks = [];

    function findPlacemarks(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(findPlacemarks);
        return;
      }
      const keys = Object.keys(node);
      for (const key of keys) {
        const lkey = key.toLowerCase();
        if (lkey === 'placemark') {
          const pm = Array.isArray(node[key]) ? node[key] : [node[key]];
          placemarks.push(...pm);
        } else {
          findPlacemarks(node[key]);
        }
      }
    }

    findPlacemarks(root);

    for (const placemark of placemarks) {
      let name = '';
      let rawCoordinates = '';
      let polygon = [];

      // Get name
      if (placemark.name) {
        name = extractFromNode(placemark.name).trim();
      }

      // Find coordinates recursively
      function findCoordinates(node) {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = findCoordinates(item);
            if (found) return found;
          }
          return null;
        }
        const keys = Object.keys(node);
        for (const key of keys) {
          if (key.toLowerCase() === 'coordinates') {
            return extractFromNode(node[key]);
          }
          const found = findCoordinates(node[key]);
          if (found) return found;
        }
        return null;
      }

      rawCoordinates = findCoordinates(placemark) || '';
      polygon = parseCoordinates(rawCoordinates);

      if (name || polygon.length > 0) {
        tenements.push({
          kmlName: name || fileName.replace('.kml', ''),
          sourceFile: fileName,
          rawCoordinates,
          polygon
        });
      }
    }
  } catch (err) {
    console.error(`Error parsing KML file ${fileName}:`, err.message);
  }

  return tenements;
}

module.exports = { parseKmlFile };
