/**
 * Anycubic Cloud client — síťový tisk přímo z prohlížeče.
 * Flow: login -> lockStorageSpace -> S3 PUT -> newUploadFile -> printersStatus
 * Protokol rozluštěn reverse engineeringem (2026-08-25).
 */

const BASE = "https://cloud-universe.anycubic.com/p/p/workbench/api";
const K1 = "f9b3528877c94d5c9c5af32245db46ef";
const K2 = "0cf75926606049a3937f56b0373b99fb";
const PC_ID = "660885c97fff3a02f22fb254cbc6c2e8";
const STORAGE_KEY = "anycubic.jwt";

// ------------------------------------------------------------ MD5 (pure JS)

export function md5Hex(input: string | Uint8Array): string {
  // klasicka MD5 implementace (bloky)
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input;
  const n = bytes.length;
  const padded = new Uint8Array(Math.ceil((n + 9) / 64) * 64);
  padded.set(bytes);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (n * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(n / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const w = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + K[i] + w[g]) | 0;
      const rotated = ((sum << S[i]) | (sum >>> (32 - S[i]))) | 0;
      const nextB = (b + rotated) | 0;
      a = d;
      d = c;
      c = b;
      b = nextB;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

function sign(ts: string, nonce: string): string {
  return md5Hex(K1 + ts + "4.1.8" + K2 + nonce + K1);
}

// ------------------------------------------------------------ API

async function api(
  path: string,
  body?: unknown,
  token?: string,
  method = "POST"
): Promise<any> {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const headers: Record<string, string> = {
    "XX-Device-Type": "pc",
    "XX-IS-CN": "1",
    "XX-LANGUAGE": "US",
    "XX-Nonce": nonce,
    "XX-Signature": sign(ts, nonce),
    "XX-Timestamp": ts,
    "XX-Version": "4.1.8",
    "Content-Type": "application/json; charset=UTF-8",
  };
  if (token) headers["XX-Token"] = token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Anycubic API vrátilo neplatnou odpověď (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    throw new Error(`Anycubic API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return payload;
}

// ------------------------------------------------------------ token

export function getStoredJwt(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredJwt(jwt: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, jwt);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ flow

export async function anycubicLogin(jwt: string): Promise<string> {
  const r = await api("/v3/public/loginWithAccessToken", {
    device_type: "pc",
    access_token: jwt,
    pc_id: PC_ID,
  });
  const token: string | undefined = r?.data?.token;
  if (!token) throw new Error("Přihlášení selhalo – zkontroluj token.");
  return token;
}

/**
 * Pošle .pm7 soubor do tiskárny přes Anycubic cloud.
 * Vrací file_id. Tiskárna si soubor stáhne; tisk spustí až uživatel na displeji.
 */
export async function sendPrintToPrinter(
  file: Uint8Array,
  fileName: string,
  jwt: string,
  onStep?: (msg: string) => void
): Promise<string> {
  onStep?.("Přihlašuji se k Anycubic cloudu…");
  const token = await anycubicLogin(jwt);

  onStep?.("Připravuji úložiště…");
  const lock = await api(
    "/v2/cloud_storage/lockStorageSpace",
    { is_temp_file: 1, size: file.length, name: fileName },
    token
  );
  const lockId: number | undefined = lock?.data?.id;
  const putUrl: string | undefined = lock?.data?.preSignUrl;
  if (!lockId || !putUrl) {
    throw new Error("Příprava úložiště selhala: " + JSON.stringify(lock?.data).slice(0, 200));
  }

  onStep?.("Nahrávám soubor do cloudu…");
  const put = await fetch(putUrl, { method: "PUT", body: new Blob([file as BlobPart]) });
  if (!put.ok) throw new Error("Nahrání souboru selhalo: HTTP " + put.status);

  onStep?.("Registruji soubor…");
  const fileMd5 = md5Hex(file);
  const reg = await api(
    "/v2/profile/newUploadFile",
    {
      user_lock_space_id: lockId,
      official_file_id: 0,
      official_file_type: 0,
      origin_file_md5: fileMd5,
      official_file_key: "",
    },
    token
  );
  const fileId: number | undefined = reg?.data?.id;
  if (!fileId) throw new Error("Registrace souboru selhala: " + JSON.stringify(reg?.data).slice(0, 200));

  onStep?.("Posílám do tiskárny…");
  await api("/v2/printer/printersStatus?file_id=" + fileId, undefined, token, "GET");
  return String(fileId);
}
