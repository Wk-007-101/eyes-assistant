/* ============================================================
   app.js — ตรรกะหลักของแอป
   ------------------------------------------------------------
   ปกติไม่ต้องแก้ไฟล์นี้ ถ้าจะปรับคำพูดหรือค่าต่าง ๆ ให้แก้ data.js
   ============================================================ */

/* ---------- ตัวแปรสถานะ ---------- */
let model = null;
let stream = null;
let running = false;
let autoMode = false;
let detectTimer = null;
let lastSpoken = {};          // { ชื่อคลาส: เวลาที่พูดล่าสุด }
let currentDetections = [];
let thaiVoice = null;

const video   = document.getElementById("cam");
const canvas  = document.getElementById("overlay");
const ctx     = canvas.getContext("2d");
const statusEl= document.getElementById("status");
const listEl  = document.getElementById("list");
const btnStart= document.getElementById("btnStart");
const btnAuto = document.getElementById("btnAuto");
const tapArea = document.getElementById("tapArea");

// canvas เล็กสำหรับอ่านค่าสี ไม่แสดงบนจอ
const sampler = document.createElement("canvas");
const sctx = sampler.getContext("2d", { willReadFrequently: true });

/* ============================================================
   ส่วนที่ 1 : เสียงพูด
   ============================================================ */

function pickThaiVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  // หาเสียงไทยก่อน ถ้าไม่มีใช้เสียงอะไรก็ได้
  return voices.find(v => v.lang && v.lang.toLowerCase().startsWith("th"))
      || voices.find(v => v.lang && v.lang.toLowerCase().startsWith("en"))
      || voices[0];
}

// เสียงในเบราว์เซอร์โหลดแบบไม่พร้อมกัน ต้องรอ event
speechSynthesis.onvoiceschanged = () => { thaiVoice = pickThaiVoice(); };
thaiVoice = pickThaiVoice();

/**
 * พูดข้อความ
 * @param {string} text
 * @param {boolean} interrupt ตัดเสียงที่กำลังพูดอยู่หรือไม่
 */
function speak(text, interrupt = false) {
  if (!text) return;
  if (interrupt) speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = "th-TH";
  u.rate = CONFIG.speechRate;
  if (thaiVoice) u.voice = thaiVoice;
  speechSynthesis.speak(u);

  setStatus(text);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function buzz() {
  if (CONFIG.vibrateMs > 0 && navigator.vibrate) {
    navigator.vibrate(CONFIG.vibrateMs);
  }
}

/* ============================================================
   ส่วนที่ 2 : การอ่านสี
   ============================================================ */

/** แปลง RGB เป็น HSV โดย h อยู่ในช่วง 0-360 ส่วน s และ v อยู่ 0-1 */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** จับคู่ค่า HSV กับชื่อสีใน data.js */
function hsvToThaiColor({ h, s, v }) {
  for (const c of COLORS) {
    if (c.vMax !== undefined && v > c.vMax) continue;
    if (c.vMin !== undefined && v < c.vMin) continue;
    if (c.sMax !== undefined && s > c.sMax) continue;
    if (c.hMin !== undefined && (h < c.hMin || h > c.hMax)) continue;
    return c.name;
  }
  return "";
}

/**
 * อ่านสีเด่นของวัตถุ
 * สุ่มอ่านพิกเซลบริเวณกลางกรอบเท่านั้น เพราะขอบกรอบมักติดพื้นหลัง
 */
function readColor(bbox) {
  const [x, y, w, h] = bbox;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return "";

  // เอาเฉพาะ 50% ตรงกลางของกรอบ
  const cx = x + w / 2, cy = y + h / 2;
  const sw = Math.max(4, w * 0.5), sh = Math.max(4, h * 0.5);
  const sx = Math.max(0, Math.min(vw - 1, cx - sw / 2));
  const sy = Math.max(0, Math.min(vh - 1, cy - sh / 2));
  const cw = Math.min(sw, vw - sx), ch = Math.min(sh, vh - sy);
  if (cw < 2 || ch < 2) return "";

  // ย่อลงเหลือ 12x12 แล้วเฉลี่ย ลดผลของ noise
  sampler.width = 12; sampler.height = 12;
  sctx.drawImage(video, sx, sy, cw, ch, 0, 0, 12, 12);

  let data;
  try { data = sctx.getImageData(0, 0, 12, 12).data; }
  catch (e) { return ""; }

  // ใช้ค่ามัธยฐานของแต่ละช่อง ทนต่อจุดสว่างจ้าได้ดีกว่าค่าเฉลี่ย
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < data.length; i += 4) {
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return hsvToThaiColor(rgbToHsv(med(rs), med(gs), med(bs)));
}

/* ============================================================
   ส่วนที่ 3 : ตำแหน่งและระยะ
   ============================================================ */

function describePosition(bbox) {
  const [x, , w] = bbox;
  const cx = (x + w / 2) / video.videoWidth;
  if (cx < 0.36) return POSITION.left;
  if (cx > 0.64) return POSITION.right;
  return POSITION.center;
}

function describeDistance(bbox) {
  const [, , w, h] = bbox;
  const area = (w * h) / (video.videoWidth * video.videoHeight);
  for (const d of DISTANCE) if (area <= d.maxArea) return d.text;
  return DISTANCE[DISTANCE.length - 1].text;
}

/** ประกอบประโยคที่จะพูด */
function buildSentence(det) {
  const name = TH_LABELS[det.class] || det.class;
  const prefix = PRIORITY[det.class] !== undefined ? PRIORITY[det.class] : "";
  const color = readColor(det.bbox);
  const pos = describePosition(det.bbox);
  const dist = describeDistance(det.bbox);

  // ตัวอย่าง: "ระวัง มี คน อยู่ทางซ้าย ระยะใกล้"
  //           "ขวด สีน้ำเงิน อยู่ตรงหน้า ระยะกลาง"
  return [prefix, name, color, "อยู่" + pos, dist]
    .filter(Boolean).join(" ");
}

/* ============================================================
   ส่วนที่ 4 : กล้องและการตรวจจับ
   ============================================================ */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },   // กล้องหลัง
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    return true;
  } catch (e) {
    console.error(e);
    speak(MESSAGES.cameraFail, true);
    return false;
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

async function loadModel() {
  setStatus(MESSAGES.loading);
  speak(MESSAGES.loading, true);
  try {
    await tf.setBackend("webgl");
  } catch (e) {
    console.warn("ใช้ webgl ไม่ได้ ใช้ backend สำรอง", e);
  }
  // lite_mobilenet_v2 เล็กและเร็วที่สุด เหมาะกับมือถือ
  model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
}

/** วนตรวจจับตามช่วงเวลาที่ตั้งไว้ ไม่ใช่ทุกเฟรม เพื่อประหยัดแบต */
async function detectLoop() {
  if (!running || !model) return;

  try {
    const raw = await model.detect(video, 10);
    currentDetections = raw
      .filter(d => d.score >= CONFIG.minScore)
      .sort((a, b) => areaOf(b) - areaOf(a));   // ใหญ่ก่อน = ใกล้ก่อน
    draw(currentDetections);
    if (autoMode) autoAnnounce(currentDetections);
    renderList(currentDetections);
  } catch (e) {
    console.error(e);
  }

  detectTimer = setTimeout(detectLoop, CONFIG.detectInterval);
}

function areaOf(d) { return d.bbox[2] * d.bbox[3]; }

/** เรียงลำดับความสำคัญ วัตถุใน PRIORITY มาก่อนเสมอ */
function rank(dets) {
  return [...dets].sort((a, b) => {
    const pa = PRIORITY[a.class] !== undefined ? 1 : 0;
    const pb = PRIORITY[b.class] !== undefined ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return areaOf(b) - areaOf(a);
  });
}

/** โหมดอัตโนมัติ พูดเฉพาะวัตถุที่ยังไม่ได้พูดเมื่อเร็ว ๆ นี้ */
function autoAnnounce(dets) {
  if (speechSynthesis.speaking) return;   // ยังพูดค้างอยู่ อย่าซ้อน

  const now = Date.now();
  const fresh = rank(dets).filter(d => {
    const t = lastSpoken[d.class] || 0;
    return now - t > CONFIG.repeatCooldown;
  }).slice(0, CONFIG.maxSpeakAuto);

  if (!fresh.length) return;

  buzz();
  fresh.forEach(d => {
    lastSpoken[d.class] = now;
    speak(buildSentence(d));
  });
}

/** ผู้ใช้แตะจอ พูดทุกอย่างที่เห็นตอนนี้ ไม่สนใจ cooldown */
function announceNow() {
  speechSynthesis.cancel();
  if (!currentDetections.length) {
    speak(MESSAGES.nothing, true);
    return;
  }
  buzz();
  const now = Date.now();
  rank(currentDetections).slice(0, CONFIG.maxSpeakTap).forEach(d => {
    lastSpoken[d.class] = now;
    speak(buildSentence(d));
  });
}

/* ============================================================
   ส่วนที่ 5 : การแสดงผลบนจอ (สำหรับผู้ช่วยและการนำเสนอ)
   ============================================================ */

function draw(dets) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw; canvas.height = vh;
  }
  ctx.clearRect(0, 0, vw, vh);
  ctx.lineWidth = Math.max(3, vw / 250);
  ctx.font = `${Math.max(18, vw / 32)}px sans-serif`;
  ctx.textBaseline = "top";

  dets.forEach(d => {
    const [x, y, w, h] = d.bbox;
    const isPriority = PRIORITY[d.class] !== undefined;
    ctx.strokeStyle = isPriority ? "#ff3b30" : "#00e676";
    ctx.strokeRect(x, y, w, h);

    const label = `${TH_LABELS[d.class] || d.class} ${(d.score * 100) | 0}%`;
    const tw = ctx.measureText(label).width + 12;
    const th = parseInt(ctx.font) + 8;
    ctx.fillStyle = isPriority ? "#ff3b30" : "#00e676";
    ctx.fillRect(x, Math.max(0, y - th), tw, th);
    ctx.fillStyle = "#000";
    ctx.fillText(label, x + 6, Math.max(0, y - th) + 4);
  });
}

function renderList(dets) {
  if (!dets.length) { listEl.textContent = "ยังไม่พบสิ่งของ"; return; }
  listEl.innerHTML = rank(dets).slice(0, 5).map(d => {
    const name = TH_LABELS[d.class] || d.class;
    return `<div class="row"><b>${name}</b> ${readColor(d.bbox)} `
         + `${describePosition(d.bbox)} ${describeDistance(d.bbox)} `
         + `<span class="sc">${(d.score * 100) | 0}%</span></div>`;
  }).join("");
}

/* ============================================================
   ส่วนที่ 6 : ปุ่มควบคุม
   ============================================================ */

btnStart.addEventListener("click", async () => {
  if (running) {
    running = false;
    clearTimeout(detectTimer);
    stopCamera();
    btnStart.textContent = "เริ่มใช้งาน";
    speak("หยุดการทำงานแล้ว", true);
    return;
  }

  btnStart.disabled = true;
  if (!model) {
    try { await loadModel(); }
    catch (e) {
      console.error(e);
      speak(MESSAGES.modelFail, true);
      btnStart.disabled = false;
      return;
    }
  }

  const ok = await startCamera();
  btnStart.disabled = false;
  if (!ok) return;

  running = true;
  btnStart.textContent = "หยุด";
  speak(MESSAGES.ready, true);
  detectLoop();
});

btnAuto.addEventListener("click", () => {
  autoMode = !autoMode;
  btnAuto.textContent = autoMode ? "โหมดอัตโนมัติ: เปิด" : "โหมดอัตโนมัติ: ปิด";
  btnAuto.classList.toggle("on", autoMode);
  lastSpoken = {};
  speak(autoMode ? MESSAGES.autoOn : MESSAGES.autoOff, true);
});

// แตะที่ไหนก็ได้บนพื้นที่กล้อง = ให้บอกสิ่งที่เห็น
tapArea.addEventListener("click", () => { if (running) announceNow(); });

// กันไม่ให้จอดับระหว่างใช้งาน
let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (e) { /* ไม่รองรับก็ข้ามไป */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) keepAwake();
});
btnStart.addEventListener("click", keepAwake);
