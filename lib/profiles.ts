/**
 * Knihovna profilů: tiskárny, pryskyřice, fólie.
 * Výběr se ukládá do localStorage ("slicer.profile.v1") — poslední volba se pamatuje.
 */

export interface PrinterProfile {
  id: string;
  name: string;
  brand: string;
  resX: number;
  resY: number;
  /** rozměry tiskové desky v mm */
  printX: number;
  printY: number;
  printZ: number;
  /** velikost pixelu v µm */
  pixelXUm: number;
  pixelYUm: number;
  /** přípona souboru (pm7, pwsz, pm7m, ...) */
  keySuffix: string;
  keyImageFormat: string;
  /** poznámka (nepovinná) */
  note?: string;
}

export interface ResinProfile {
  id: string;
  name: string;
  brand: string;
  type: string;
  /** hustota g/ml */
  density: number;
  bottomLayers: number;
  bottomExposure: number; // s
  normalExposure: number; // s @ 50 µm
  note?: string;
}

export interface FilmProfile {
  id: string;
  name: string;
  /** násobitel expozice oproti FEP (ACF snáz pouští → méně expozice) */
  exposureFactor: number;
  note?: string;
}

export const PRINTERS: PrinterProfile[] = [
  {
    id: "m7",
    name: "Photon Mono M7",
    brand: "Anycubic",
    resX: 13312,
    resY: 5120,
    printX: 223.64,
    printY: 126.48,
    printZ: 230,
    pixelXUm: 16.8,
    pixelYUm: 24.8,
    keySuffix: "pm7",
    keyImageFormat: "pwszImg",
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
    note: "hodnoty předběžné — ověřit v Photon Workshopu",
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
    note: "hodnoty předběžné",
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
    note: "hodnoty předběžné",
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
    note: "Elegoo používá Chitu (.ctb) — export .pm7 neplatí, jen profil desky",
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
    note: "Chitu (.ctb) — profil desky pro testy",
  },
];

export const RESINS: ResinProfile[] = [
  { id: "anycubic-standard", name: "Standard", brand: "Anycubic", type: "standard", density: 1.1, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "anycubic-abslike", name: "ABS-like Pro 2", brand: "Anycubic", type: "abs-like", density: 1.1, bottomLayers: 6, bottomExposure: 32, normalExposure: 2.2 },
  { id: "anycubic-water", name: "Water-washable", brand: "Anycubic", type: "water-washable", density: 1.1, bottomLayers: 6, bottomExposure: 40, normalExposure: 2.8 },
  { id: "anycubic-clear", name: "Clear", brand: "Anycubic", type: "transparent", density: 1.1, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "anycubic-tough", name: "Tough", brand: "Anycubic", type: "tough", density: 1.15, bottomLayers: 6, bottomExposure: 38, normalExposure: 2.8 },
  { id: "anycubic-flex", name: "Flexible", brand: "Anycubic", type: "flexible", density: 1.15, bottomLayers: 8, bottomExposure: 45, normalExposure: 3.5 },
  { id: "elegoo-standard", name: "Standard", brand: "Elegoo", type: "standard", density: 1.1, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
  { id: "elegoo-abslike", name: "ABS-like", brand: "Elegoo", type: "abs-like", density: 1.1, bottomLayers: 6, bottomExposure: 30, normalExposure: 2.3 },
  { id: "siraya-simple", name: "Simple", brand: "Siraya Tech", type: "standard", density: 1.1, bottomLayers: 6, bottomExposure: 30, normalExposure: 2.5 },
  { id: "siraya-fast", name: "Fast", brand: "Siraya Tech", type: "fast", density: 1.1, bottomLayers: 6, bottomExposure: 25, normalExposure: 2.0 },
  { id: "phrozen-aqua", name: "Aqua", brand: "Phrozen", type: "standard", density: 1.1, bottomLayers: 6, bottomExposure: 35, normalExposure: 3.0 },
  { id: "sunlu-standard", name: "Standard", brand: "Sunlu", type: "standard", density: 1.1, bottomLayers: 6, bottomExposure: 35, normalExposure: 2.5 },
];

export const FILMS: FilmProfile[] = [
  { id: "fep", name: "FEP", exposureFactor: 1.0 },
  { id: "nfep", name: "nFEP", exposureFactor: 0.95, note: "méně expozice než FEP" },
  { id: "acf", name: "ACF", exposureFactor: 0.85, note: "nejlépe pouští tisk — nejméně expozice" },
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

/** Načte poslední použitý profil (tiskárna/pryskyřice/fólie/nastavení). */
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
    /* tichý fallback */
  }
}
