import { Database } from "bun:sqlite";
import { calculateCO2Emissions } from '../src/utils/co2'
const db = new Database("ghosts.db", { create: true });
const results = db.query(`SELECT playerId, raceIndex, version, waypoints FROM ghosts`).all()
db.exec(`ALTER TABLE ghosts ADD COLUMN kgCO2e REAL`)

for (let i = 0; i < results.length; i++) {
  const result = results[i]
  const { playerId, raceIndex, version } = result as any;
  const waypoints = JSON.parse((result as any).waypoints)
  const co2Emissions = calculateCO2Emissions(waypoints)
  db.exec(`UPDATE ghosts SET kgCO2e = ${co2Emissions} WHERE playerId = "${playerId}" AND raceIndex = "${raceIndex}" AND version = ${version}`)
}
