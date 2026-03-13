const axios = require('axios');

const TENGRAPH_API_URL = process.env.TENGRAPH_API_URL ||
  'https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Industry_and_Mining_WFS/MapServer/3/query';

try {
  const _u = new URL(TENGRAPH_API_URL);
  if (!_u.hostname.endsWith('slip.wa.gov.au') && !_u.hostname.endsWith('arcgis.com')) {
    throw new Error(`Unexpected TENGRAPH host: ${_u.hostname}`);
  }
} catch (e) {
  console.error('Invalid TENGRAPH_API_URL:', e.message);
  process.exit(1);
}

function formatDate(timestamp) {
  if (!timestamp || timestamp <= 0) return null;
  try {
    return new Date(timestamp);
  } catch {
    return null;
  }
}

async function queryByGeometry(polygon, tenementName) {
  if (!polygon || polygon.length < 3) {
    return [];
  }

  const geometry = {
    rings: [polygon],
    spatialReference: { wkid: 4326 }
  };

  const params = {
    geometry: JSON.stringify(geometry),
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json'
  };

  try {
    const response = await axios.get(TENGRAPH_API_URL, {
      params,
      timeout: 30000
    });

    const data = response.data;

    if (data.features && data.features.length > 0) {
      return data.features.map(f => f.attributes);
    }
    return [];
  } catch (err) {
    console.error(`TENGRAPH API error for ${tenementName}:`, err.message);
    return [];
  }
}

function mapApiDataToTenement(apiData) {
  const tenementId = apiData.fmt_tenid || apiData.tenid || null;
  const holderCount = parseInt(apiData.holdercnt) || 0;

  const holders = [];
  for (let i = 1; i <= Math.min(holderCount, 10); i++) {
    const name = apiData[`holder${i}`];
    if (name) {
      holders.push({
        name,
        address: apiData[`addr${i}`] || ''
      });
    }
  }

  return {
    matched: true,
    tenementId,
    tenStatus: apiData.tenstatus || null,
    tenType: apiData.type || null,
    legalArea: parseFloat(apiData.legal_area) || null,
    areaUnit: apiData.unit_of_me || null,
    surveyStatus: apiData.survstatus || null,
    grantDate: formatDate(apiData.grantdate),
    startDate: formatDate(apiData.startdate),
    endDate: formatDate(apiData.enddate),
    holderCount,
    holders,
    apiRawData: apiData
  };
}

module.exports = { queryByGeometry, mapApiDataToTenement };
