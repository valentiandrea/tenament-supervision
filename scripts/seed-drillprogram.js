/**
 * Seed the West Barlee drill program into MongoDB.
 * Usage:  node scripts/seed-drillprogram.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');

const DrillProgram = require('../models/DrillProgram');
const KMLProject   = require('../models/KMLProject');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // ── Parse drill program CSV ────────────────────────────────
  const drillCsv = path.join(__dirname, '..', 'westbarlee', 'drill program.csv');
  const lines    = fs.readFileSync(drillCsv, 'utf8').trim().split('\n');

  const holes = lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim());
    return {
      type:        cols[0],
      name:        cols[1],
      easting:     parseFloat(cols[2]),
      northing:    parseFloat(cols[3]),
      azimuth:     parseFloat(cols[4]),
      dip:         parseFloat(cols[5]),
      targetDepth: parseFloat(cols[6])
    };
  }).filter(h => !isNaN(h.easting));

  console.log(`Parsed ${holes.length} drill holes`);

  // ── Estimate surface elevation from ore body CSV ───────────
  const oreBodyFile = path.join(__dirname, '..', 'westbarlee', 'west_barlee.csv');
  let surfaceElevation = 0;
  try {
    const sample = fs.readFileSync(oreBodyFile, 'utf8').split('\n').slice(1, 20001);
    const zVals  = sample.filter(l => l.trim()).map(l => parseFloat(l.split(',')[2])).filter(z => !isNaN(z));
    surfaceElevation = Math.max(...zVals);
    console.log(`Estimated surface elevation: ${surfaceElevation.toFixed(1)} m`);
  } catch (e) {
    console.warn('Could not estimate surface elevation:', e.message);
  }

  // ── Link to KML project if it exists ──────────────────────
  const kmlName = '8-364926';
  const project = await KMLProject.findOne({
    $or: [
      { kmlName:     { $regex: kmlName, $options: 'i' } },
      { projectName: { $regex: 'west barlee', $options: 'i' } }
    ]
  }).lean();
  if (project) console.log(`Linked to KML project: ${project.projectName || project.kmlName}`);
  else          console.log('No matching KML project found — linking skipped');

  // ── Upsert drill program ───────────────────────────────────
  await DrillProgram.deleteMany({ kmlName });

  const prog = await DrillProgram.create({
    name:             'West Barlee',
    kmlName,
    projectId:        project ? project._id : undefined,
    oreBodyFile,
    surfaceElevation,
    holes
  });

  console.log(`Created drill program: ${prog._id}`);
  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
