/**
 * Knihovna profilĹŻ: tiskĂˇrny, pryskyĹ™ice, fĂłlie.
 * VĂ˝bÄ›r se uklĂˇdĂˇ do localStorage ("slicer.profile.v1") â€” poslednĂ­ volba se pamatuje.
 */

export interface PrinterProfile {
  id: string;
  name: string;
  brand: string;
  resX: number;
  resY: number;
  /** rozmÄ›ry tiskovĂ© desky v mm */
  printX: number;
  printY: number;
  printZ: number;
  /** velikost pixelu v Âµm */
  pixelXUm: number;
  pixelYUm: number;
  /** pĹ™Ă­pona souboru (pm7, pwsz, pm7m, ...) */
  keySuffix: string;
  keyImageFormat: string;
  /** poznĂˇmka (nepovinnĂˇ) */
  note?: string;
}

export interface ResinProfile {
  id: string;
  name: string;
  brand: string;
  type: string;
  /** hustota g/ml */
  density: number;
  /** cena za litr ($/1000 ml) â€” pro odhad ceny tisku */
  price: number;
  bottomLayers: number;
  bottomExposure: number; // s
  normalExposure: number; // s @ 50 Âµm
  note?: string;
}

export interface FilmProfile {
  id: string;
  name: string;
  /** nĂˇsobitel expozice oproti FEP (ACF snĂˇz pouĹˇtĂ­ â†’ mĂ©nÄ› expozice) */
  exposureFactor: number;
  note?: string;
}

export const PRINTERS: PrinterProfile[] = [
  {
    id: "m7",
    name: "Photon Mono M7",
    brand: "Anycubic",
    resX: 11520, // ovÄ›Ĺ™eno z cloudu (firmware 4.0.6.7) â€” 12K, ne 14K!
    resY: 5120,
    printX: 223.642,
    printY: 126.48,
    printZ: 230,
    pixelXUm: 19.4, // 223.642/11520
    pixelYUm: 24.7, // 126.48/5120
    keySuffix: "pm7",
    keyImageFormat: "pw0Img",
  },
  {
    id: "m7-pro",
    name: "Photon Mono M7 Pro",
    brand: "Anycubic",
    resX: 13312,
    resY: 5120,
    printX: 223.64,
    printY: 126.48,
    printZ: 230,
    pixelXUm: 16.8,
    pixelYUm: 24.7,
    keySuffix: "pwsz",
    keyImageFormat: "pwszImg",
  },
  {
    id: "m7-max",
    name: "Photon Mono M7 Max",
    brand: "Anycubic",
    resX: 11520,
    resY: 5120,
    printX: 240,
    printY: 127,
    printZ: 250,
    pixelXUm: 20.8,
    pixelYUm: 24.8,
    keySuffix: "pm7m",
    keyImageFormat: "pw0Img",
    note: "hodnoty pĹ™edbÄ›ĹľnĂ© â€” ovÄ›Ĺ™it v Photon Workshopu",
  },
  {
    id: "m5s",
    name: "Photon Mono M5s",
    brand: "Anycubic",
    resX: 11520,
    resY: 5120,
    printX: 196,
    printY: 122,
    printZ: 220,
    pixelXUm: 17.0,
    pixelYUm: 23.8,
    keySuffix: "pm5s",
    keyImageFormat: "pwszImg",
    note: "hodnoty pĹ™edbÄ›ĹľnĂ©",
  },
  {
    id: "mono2",
    name: "Photon Mono 2",
    brand: "Anycubic",
    resX: 4096,
    resY: 2560,
    printX: 165,
    printY: 89,
    printZ: 165,
    pixelXUm: 40.3,
    pixelYUm: 34.8,
    keySuffix: "photon",
    keyImageFormat: "pw0Img",
    note: "hodnoty pĹ™edbÄ›ĹľnĂ©",
  },
  {
    id: "saturn4",
    name: "Saturn 4",
    brand: "Elegoo",
    resX: 11520,
    resY: 5120,
    printX: 218.88,
    printY: 122.88,
    printZ: 260,
    pixelXUm: 19.0,
    pixelYUm: 24.0,
    keySuffix: "ctb",
    keyImageFormat: "pwszImg",
    note: "Elegoo pouĹľĂ­vĂˇ Chitu (.ctb) â€” export .pm7 neplatĂ­, jen profil desky",
  },
  {
    id: "sonic-mega8k",
    name: "Sonic Mega 8K",
    brand: "Phrozen",
    resX: 7500,
    resY: 3240,
    printX: 330,
    printY: 185,
    printZ: 400,
    pixelXUm: 44.0,
    pixelYUm: 57.0,
    keySuffix: "ctb",
    keyImageFormat: "pwszImg",
    note: "Chitu (.ctb) â€” profil desky pro testy",
  },
];

export const RESINS: ResinProfile[] = [
  { id: "anycubic-standard", name: "Standard", brand: "Anycubic", type: "standard", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "anycubic-abslike", name: "ABS-like Pro 2", brand: "Anycubic", type: "abs-like", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 32, normalExposure: 2.2 },
  { id: "anycubic-water", name: "Water-washable", brand: "Anycubic", type: "water-washable", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 40, normalExposure: 2.8 },
  { id: "anycubic-clear", name: "Clear", brand: "Anycubic", type: "transparent", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "anycubic-tough", name: "Tough", brand: "Anycubic", type: "tough", density: 1.15, price: 220, bottomLayers: 6, bottomExposure: 38, normalExposure: 2.8 },
  { id: "anycubic-flex", name: "Flexible", brand: "Anycubic", type: "flexible", density: 1.15, price: 220, bottomLayers: 8, bottomExposure: 45, normalExposure: 3.5 },
  { id: "elegoo-standard", name: "Standard", brand: "Elegoo", type: "standard", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "elegoo-abslike", name: "ABS-like", brand: "Elegoo", type: "abs-like", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 30, normalExposure: 2.3 },
  { id: "siraya-simple", name: "Simple", brand: "Siraya Tech", type: "standard", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 30, normalExposure: 2.5 },
  { id: "siraya-fast", name: "Fast", brand: "Siraya Tech", type: "fast", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 25, normalExposure: 2.0 },
  { id: "phrozen-aqua", name: "Aqua", brand: "Phrozen", type: "standard", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 35, normalExposure: 3.0 },
  { id: "sunlu-standard", name: "Standard", brand: "Sunlu", type: "standard", density: 1.1, price: 220, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
];

export const FILMS: FilmProfile[] = [
  { id: "fep", name: "FEP", exposureFactor: 1.0 },
  { id: "nfep", name: "nFEP", exposureFactor: 0.95, note: "mĂ©nÄ› expozice neĹľ FEP" },
  { id: "acf", name: "ACF", exposureFactor: 0.85, note: "nejlĂ©pe pouĹˇtĂ­ tisk â€” nejmĂ©nÄ› expozice" },
];

export const DEFAULT_PRINTER_ID = "m7";
export const DEFAULT_RESIN_ID = "anycubic-standard";
export const DEFAULT_FILM_ID = "fep";

export function getPrinter(id: string): PrinterProfile {
  return PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];
}
export function getResin(id: string): ResinProfile {
  return RESINS.find((r) => r.id === id) ?? RESINS[0];
}
export function getFilm(id: string): FilmProfile {
  return FILMS.find((f) => f.id === id) ?? FILMS[0];
}

export interface SavedProfile {
  printerId: string;
  resinId: string;
  filmId: string;
  settings: {
    layerHeight: number;
    bottomExposure: number;
    normalExposure: number;
    bottomLayers: number;
    supports: boolean;
    aa: boolean;
  };
}

const STORAGE_KEY = "slicer.profile.v1";

/** NaÄŤte poslednĂ­ pouĹľitĂ˝ profil (tiskĂˇrna/pryskyĹ™ice/fĂłlie/nastavenĂ­). */
export function loadSavedProfile(): SavedProfile | null {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedProfile) : null;
  } catch {
    return null;
  }
}

export function saveProfile(p: SavedProfile): void {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* tichĂ˝ fallback */
  }
}

