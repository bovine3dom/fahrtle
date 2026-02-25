import { tableFromIPC, type Vector } from "apache-arrow";
import { latLngToCell } from "h3-js";

const fetchCountryData = async () => {
    const response = await fetch("ne_10m_admin_0_countries.asc.arrow");
    const table = await tableFromIPC(response);
    return table;
};

const countryTablePromise = fetchCountryData();

function binarySearch(vec: Vector, target: bigint) {
  let low = 0;
  let high = vec.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1; // premature optimisation is the root of all fun
    const midVal = vec.get(mid) as bigint; 
    if (midVal === target) {
      return mid; // Found it!
    } else if (midVal < target) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return -1; // Not found
}

// takes like 400ns, that'll do
export async function getCountry({ lat, lon }: { lat: number; lon: number }): Promise<string | null> {
    const table = await countryTablePromise;
    const h3s = table.getChild("h3") as Vector;
    const countries = table.getChild("ISO_A2_EH")

    for (let res = 1; res <= 7; res++) {
        const h3Cell = BigInt("0x" + latLngToCell(lat, lon, res));
        const result = binarySearch(h3s, h3Cell);
        if (result > -1) {
            return countries!.get(result);
        }
    }

    return null;
}

export const countryToFlag = (a2: string) => {
  if (!a2 || a2.length !== 2) return '🌊';
  const offset = 127397;
  return String.fromCodePoint(...a2.split('').map(c => c.charCodeAt(0) + offset));
};

