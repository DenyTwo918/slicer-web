/**
 * Anycubic network print — poslani .pm7 do tiskarny pres cloud.
 * Flow: login -> lockStorageSpace -> S3 PUT -> newUploadFile -> printersStatus?file_id
 * Pouziti: node send-print.mjs <soubor.pm7> [--send]
 *   (bez --send jen nahraje do cloudu a vrati file_id; s --send posle do tiskarny)
 */
import fs from "fs";
import crypto from "crypto";

const BASE = "https://cloud-universe.anycubic.com/p/p/workbench/api";
const K1 = "f9b3528877c94d5c9c5af32245db46ef";
const K2 = "0cf75926606049a3937f56b0373b99fb";
const PC_ID = "660885c97fff3a02f22fb254cbc6c2e8";

// Casdoor JWT z global_config.ini (login do makeronline)
const ini = fs.readFileSync(
  "C:\\Users\\danie\\AppData\\Local\\Anycubic\\AnycubicPhotonWorkshop_V4.1.8\\global_config.ini",
  "utf8"
);
const JWT = (ini.match(/accessToken=([^\r\n]+)/) || [])[1];

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex").toUpperCase();
}

function sign(ts, nonce) {
  return md5(K1 + ts + "4.1.8" + K2 + nonce + K1);
}

async function api(path, body, token, method = "POST") {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const headers = {
    "XX-Device-Type": "pc",
    "XX-IS-CN": "1",
    "XX-LANGUAGE": "US",
    "XX-Nonce": nonce,
    "XX-Signature": sign(ts, nonce),
    "XX-Timestamp": ts,
    "XX-Version": "4.1.8",
    "Content-Type": "application/json; charset=UTF-8",
    "User-Agent": "slicer-web",
  };
  if (token) headers["XX-Token"] = token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  return j;
}

const file = process.argv[2];
const sendToPrinter = process.argv.includes("--send");
if (!file) { console.error("Pouzij: node send-print.mjs <soubor.pm7> [--send]"); process.exit(1); }
const fileData = fs.readFileSync(file);
const fileName = file.split(/[\\/]/).pop();

console.log("=== 1) Login ===");
const login = await api("/v3/public/loginWithAccessToken", { device_type: "pc", access_token: JWT, pc_id: PC_ID });
const token = login?.data?.token;
if (!token) { console.error("Login selhal:", JSON.stringify(login).slice(0, 200)); process.exit(1); }
console.log("Login OK, token:", token.slice(0, 30) + "...");

console.log("\n=== 2) lockStorageSpace ===");
const lock = await api("/v2/cloud_storage/lockStorageSpace", { is_temp_file: 1, size: fileData.length, name: fileName }, token);
console.log("lock odpoved:", JSON.stringify(lock).slice(0, 400));
const lockId = lock?.data?.id;
const putUrl = lock?.data?.preSignUrl;
if (!lockId || !putUrl) { console.error("Chybi lock id / upload URL z odpovedi:", JSON.stringify(lock?.data).slice(0, 300)); process.exit(1); }

console.log("\n=== 3) S3 PUT ===");
const put = await fetch(putUrl, { method: "PUT", body: fileData });
console.log("S3 PUT status:", put.status);

console.log("\n=== 4) newUploadFile ===");
const fileMd5 = crypto.createHash("md5").update(fileData).digest("hex").toUpperCase();
const reg = await api("/v2/profile/newUploadFile", {
  user_lock_space_id: lockId,
  official_file_id: 0,
  official_file_type: 0,
  origin_file_md5: fileMd5,
  official_file_key: "",
}, token);
console.log("newUploadFile:", JSON.stringify(reg).slice(0, 400));
const fileId = reg?.data?.file_id || reg?.data?.id;
if (!fileId) { console.error("Chybi file_id:", JSON.stringify(reg?.data).slice(0, 300)); process.exit(1); }
console.log("file_id:", fileId);

console.log("\n=== 5) Odeslani do tiskarny ===");
if (sendToPrinter) {
  const st = await api("/v2/printer/printersStatus?file_id=" + fileId, {}, token, "GET");
  console.log("printersStatus:", JSON.stringify(st).slice(0, 400));
  console.log("\nTiskarna si soubor stahne (MQTT print/report downloading). Tisk NEbiha automaticky.");
} else {
  console.log("(preskoceno — spust s --send pro odeslani do tiskarny)");
}
console.log("\nHOTOVO. file_id:", fileId);
