/* ============================================================
   app.js — ตรรกะหลักของแอป
   ------------------------------------------------------------
   ปกติไม่ต้องแก้ไฟล์นี้ ถ้าจะปรับคำพูดหรือค่าต่าง ๆ ให้แก้ data.js

   หลักการออกแบบสำหรับผู้พิการทางสายตา
   1. ก่อนเริ่ม ทั้งหน้าจอคือปุ่มเริ่ม แตะตรงไหนก็ได้
      (เบราว์เซอร์ห้ามเล่นเสียงก่อนผู้ใช้แตะ จึงพูดทักทายเองไม่ได้)
   2. หลังเริ่ม ระบบพูดสอนวิธีใช้ทันที ไม่ต้องหาปุ่ม
   3. แตะปุ่มค้าง = ฟังชื่อปุ่ม / ยกนิ้วบนปุ่ม = กด / เลื่อนออกแล้วยก = ยกเลิก
   4. มีป้าย ARIA ครบ เพื่อให้ TalkBack อ่านได้ถูกต้อง
   ============================================================ */

let model = null, stream = null;
let running = false, autoMode = false, started = false;
let modeIndex = 0;              // ตำแหน่งในรายการ MODES
let modelCache = {};            // เก็บโมเดลที่โหลดแล้ว ไม่ต้องโหลดซ้ำ
let detectTimer = null;
let lastSpoken = {};
let currentDetections = [];
let thaiVoice = null;

const video    = document.getElementById("cam");
const canvas   = document.getElementById("overlay");
const ctx      = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const listEl   = document.getElementById("list");
const btnStop  = document.getElementById("btnStop");
const btnAuto  = document.getElementById("btnAuto");
const btnMode  = document.getElementById("btnMode");
const btnHelp  = document.getElementById("btnHelp");
const tapArea  = document.getElementById("tapArea");
const startLayer = document.getElementById("startLayer");

const sampler = document.createElement("canvas");
const sctx = sampler.getContext("2d", { willReadFrequently: true });

/* ============================================================
   1. เสียงพูด
   ============================================================ */

function pickThaiVoice() {
  const v = speechSynthesis.getVoices();
  if (!v.length) return null;
  return v.find(x => x.lang && x.lang.toLowerCase().startsWith("th"))
      || v.find(x => x.lang && x.lang.toLowerCase().startsWith("en"))
      || v[0];
}
speechSynthesis.onvoiceschanged = () => { thaiVoice = pickThaiVoice(); };
thaiVoice = pickThaiVoice();

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

/** พูดหลายประโยคต่อกัน ใช้กับบทสอนใช้งาน */
function speakLines(lines, interrupt = true) {
  if (interrupt) speechSynthesis.cancel();
  lines.forEach((t, i) => speak(t, false));
}

function setStatus(t) { statusEl.textContent = t; }

/* รูปแบบการสั่นต่างกันตามเหตุการณ์ ให้รับรู้ได้โดยไม่ต้องฟัง */
const BUZZ = {
  found:   [40],            // พบวัตถุใหม่
  toggle:  [30, 60, 30],    // เปลี่ยนโหมด
  start:   [80, 80, 80],    // เริ่มระบบ
  error:   [200],           // ผิดพลาด
  hover:   [15],            // นิ้วแตะโดนปุ่ม
};
function buzz(kind) {
  if (CONFIG.vibrateMs <= 0 || !navigator.vibrate) return;
  navigator.vibrate(BUZZ[kind] || BUZZ.found);
}

/* ============================================================
   2. การอ่านสี
   ============================================================ */

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

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

function readColor(bbox) {
  const [x, y, w, h] = bbox;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return "";
  const cx = x + w / 2, cy = y + h / 2;
  const sw = Math.max(4, w * 0.5), sh = Math.max(4, h * 0.5);
  const sx = Math.max(0, Math.min(vw - 1, cx - sw / 2));
  const sy = Math.max(0, Math.min(vh - 1, cy - sh / 2));
  const cw = Math.min(sw, vw - sx), ch = Math.min(sh, vh - sy);
  if (cw < 2 || ch < 2) return "";
  sampler.width = 12; sampler.height = 12;
  sctx.drawImage(video, sx, sy, cw, ch, 0, 0, 12, 12);
  let data;
  try { data = sctx.getImageData(0, 0, 12, 12).data; } catch (e) { return ""; }
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < data.length; i += 4) {
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return hsvToThaiColor(rgbToHsv(med(rs), med(gs), med(bs)));
}

/* ============================================================
   3. ตำแหน่ง ระยะ และการประกอบประโยค
   ============================================================ */

function describePosition(bbox) {
  const cx = (bbox[0] + bbox[2] / 2) / video.videoWidth;
  if (cx < 0.36) return POSITION.left;
  if (cx > 0.64) return POSITION.right;
  return POSITION.center;
}

function describeDistance(bbox) {
  const area = (bbox[2] * bbox[3]) / (video.videoWidth * video.videoHeight);
  for (const d of DISTANCE) if (area <= d.maxArea) return d.text;
  return DISTANCE[DISTANCE.length - 1].text;
}

/** แปลชื่อคลาส ImageNet เป็นไทย ถ้าไม่มีคำแปลคืนภาษาอังกฤษ */
function thaiImageNet(raw) {
  const low = raw.toLowerCase();
  if (IMAGENET_TH[low]) return IMAGENET_TH[low];
  for (const part of low.split(",")) {
    const p = part.trim();
    if (IMAGENET_TH[p]) return IMAGENET_TH[p];
  }
  return raw.split(",")[0].trim();
}

/** ประโยคสำหรับโหมดคำศัพท์กว้าง ไม่มีตำแหน่งเพราะจำแนกทั้งภาพ */
function buildClassifySentence(c) {
  const name = thaiImageNet(c.className);
  const unsure = c.probability < CONFIG.unsureBelow ? MESSAGES.unsure : "";
  const color = centerColor();
  return [unsure, name, color].filter(Boolean).join(" ");
}

/** อ่านสีจากบริเวณกลางภาพ ใช้กับโหมดจำแนกทั้งภาพ */
function centerColor() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return "";
  return readColor([vw * 0.3, vh * 0.3, vw * 0.4, vh * 0.4]);
}

function buildSentence(det) {
  const name   = TH_LABELS[det.class] || det.class;
  const alert  = PRIORITY[det.class] !== undefined ? PRIORITY[det.class] : "";
  // ความมั่นใจต่ำ ต้องบอกผู้ใช้ว่าไม่แน่ใจ ไม่ใช่พูดเหมือนมั่นใจเต็มร้อย
  const unsure = det.score < CONFIG.unsureBelow ? MESSAGES.unsure : "";
  const color  = NO_COLOR.includes(det.class) ? "" : readColor(det.bbox);
  return [alert, unsure, name, color,
          "อยู่" + describePosition(det.bbox),
          describeDistance(det.bbox)].filter(Boolean).join(" ");
}

/* ============================================================
   4. กล้อง โมเดล และการตรวจจับ
   ============================================================ */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" },
               width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    return true;
  } catch (e) {
    console.error(e);
    buzz("error");
    speak(MESSAGES.cameraFail, true);
    return false;
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

function currentMode() { return MODES[modeIndex]; }

/**
 * โหลดโมเดลของโหมดที่ระบุ โหลดครั้งเดียวแล้วเก็บไว้ใช้ซ้ำ
 * โหมด detect ใช้ COCO-SSD / โหมด classify ใช้ MobileNet
 */
async function loadModelFor(mode) {
  if (modelCache[mode.id]) return modelCache[mode.id];
  try { await tf.setBackend("webgl"); }
  catch (e) { console.warn("ใช้ webgl ไม่ได้", e); }

  const m = mode.type === "detect"
    ? await cocoSsd.load({ base: mode.base })
    : await mobilenet.load({ version: 2, alpha: 1.0 });

  modelCache[mode.id] = m;
  return m;
}

function areaOf(d) { return d.bbox[2] * d.bbox[3]; }

/** พื้นที่ทับซ้อนต่อพื้นที่รวม ใช้ตัดกรอบซ้ำ */
function iou(a, b) {
  const [ax, ay, aw, ah] = a.bbox, [bx, by, bw, bh] = b.bbox;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = aw * ah + bw * bh - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/** คลาสเดียวกันที่ทับกันมาก ถือเป็นวัตถุเดียว เก็บอันที่มั่นใจกว่า */
function dedupe(dets) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of sorted) {
    if (!keep.some(k => k.class === d.class && iou(k, d) > CONFIG.dedupeIoU)) {
      keep.push(d);
    }
  }
  return keep;
}

async function detectLoop() {
  if (!running || !model) return;
  const mode = currentMode();
  try {
    if (mode.type === "detect") {
      const raw = await model.detect(video, 12);
      currentDetections = dedupe(raw.filter(d => d.score >= CONFIG.minScore))
                            .sort((a, b) => areaOf(b) - areaOf(a));
      draw(currentDetections);
      if (autoMode) autoAnnounce(currentDetections);
      renderList(currentDetections);
    } else {
      const res = await model.classify(video, 3);
      currentDetections = res.filter(c => c.probability >= 0.12);
      drawCenterGuide();
      if (autoMode) autoAnnounceClassify(currentDetections);
      renderListClassify(currentDetections);
    }
  } catch (e) { console.error(e); }
  detectTimer = setTimeout(detectLoop, CONFIG.detectInterval);
}

/** โหมดคำศัพท์กว้าง พูดอันดับหนึ่งเมื่อเปลี่ยนจากครั้งก่อน */
let lastClassName = "", lastClassAt = 0;
function autoAnnounceClassify(list) {
  if (!list.length || speechSynthesis.speaking) return;
  const top = list[0];
  const now = Date.now();
  if (top.className === lastClassName &&
      now - lastClassAt < CONFIG.repeatCooldown) return;
  lastClassName = top.className; lastClassAt = now;
  buzz("found");
  speak(buildClassifySentence(top));
}

/** กรอบนำสายตาตรงกลาง บอกผู้ใช้ว่าให้เล็งวัตถุไว้ตรงนี้ */
function drawCenterGuide() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw; canvas.height = vh;
  }
  ctx.clearRect(0, 0, vw, vh);
  ctx.strokeStyle = "#ffe600";
  ctx.lineWidth = Math.max(4, vw / 200);
  ctx.setLineDash([vw / 30, vw / 40]);
  ctx.strokeRect(vw * 0.15, vh * 0.2, vw * 0.7, vh * 0.6);
  ctx.setLineDash([]);
}

function renderListClassify(list) {
  if (!list.length) { listEl.textContent = "ยังไม่พบสิ่งของ"; return; }
  listEl.innerHTML = list.map(c => {
    const u = c.probability < CONFIG.unsureBelow ? "? " : "";
    return `<div class="row">${u}<b>${thaiImageNet(c.className)}</b> `
         + `<span class="sc">${(c.probability * 100) | 0}%</span></div>`;
  }).join("");
}

function rank(dets) {
  return [...dets].sort((a, b) => {
    const pa = PRIORITY[a.class] !== undefined ? 1 : 0;
    const pb = PRIORITY[b.class] !== undefined ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return areaOf(b) - areaOf(a);
  });
}

function autoAnnounce(dets) {
  if (speechSynthesis.speaking) return;
  const now = Date.now();
  const fresh = rank(dets)
    .filter(d => now - (lastSpoken[d.class] || 0) > CONFIG.repeatCooldown)
    .slice(0, CONFIG.maxSpeakAuto);
  if (!fresh.length) return;
  buzz("found");
  fresh.forEach(d => { lastSpoken[d.class] = now; speak(buildSentence(d)); });
}

function announceNow() {
  speechSynthesis.cancel();
  if (!currentDetections.length) { speak(MESSAGES.nothing, true); return; }
  buzz("found");
  if (currentMode().type === "classify") {
    currentDetections.slice(0, 2).forEach(c => speak(buildClassifySentence(c)));
    return;
  }
  const now = Date.now();
  rank(currentDetections).slice(0, CONFIG.maxSpeakTap).forEach(d => {
    lastSpoken[d.class] = now;
    speak(buildSentence(d));
  });
}

/* ============================================================
   5. การแสดงผลบนจอ สำหรับผู้ช่วยและการนำเสนอ
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
    const pri = PRIORITY[d.class] !== undefined;
    ctx.strokeStyle = pri ? "#ff3b30" : "#00e676";
    ctx.strokeRect(x, y, w, h);
    const label = `${TH_LABELS[d.class] || d.class} ${(d.score * 100) | 0}%`;
    const tw = ctx.measureText(label).width + 12, th = parseInt(ctx.font) + 8;
    ctx.fillStyle = pri ? "#ff3b30" : "#00e676";
    ctx.fillRect(x, Math.max(0, y - th), tw, th);
    ctx.fillStyle = "#000";
    ctx.fillText(label, x + 6, Math.max(0, y - th) + 4);
  });
}

function renderList(dets) {
  if (!dets.length) { listEl.textContent = "ยังไม่พบสิ่งของ"; return; }
  listEl.innerHTML = rank(dets).slice(0, 5).map(d => {
    const name = TH_LABELS[d.class] || d.class;
    const col = NO_COLOR.includes(d.class) ? "" : readColor(d.bbox);
    const u = d.score < CONFIG.unsureBelow ? "? " : "";
    return `<div class="row">${u}<b>${name}</b> ${col} `
         + `${describePosition(d.bbox)} ${describeDistance(d.bbox)} `
         + `<span class="sc">${(d.score * 100) | 0}%</span></div>`;
  }).join("");
}

/* ============================================================
   6. การเริ่มระบบ  แตะที่ใดก็ได้บนหน้าจอ
   ============================================================ */

async function bootstrap() {
  if (started) return;
  started = true;

  // ต้องพูดภายในเหตุการณ์สัมผัสของผู้ใช้ ไม่งั้นเบราว์เซอร์บล็อกเสียง
  speak(MESSAGES.welcome, true);
  buzz("start");
  speak(MESSAGES.loading);

  modeIndex = Math.max(0, MODES.findIndex(m => m.id === DEFAULT_MODE));
  try { model = await loadModelFor(currentMode()); }
  catch (e) {
    console.error(e); buzz("error");
    speak(MESSAGES.modelFail, true); started = false; return;
  }

  const ok = await startCamera();
  if (!ok) { started = false; return; }

  startLayer.style.display = "none";
  document.getElementById("controls").style.display = "grid";
  running = true;
  btnMode.textContent = currentMode().label;
  speak(MESSAGES.cameraOn);
  speakLines(MESSAGES.tutorial, false);
  speak(currentMode().say);
  detectLoop();
}

startLayer.addEventListener("click", bootstrap);

/* ============================================================
   7. ปุ่มควบคุม  แตะค้างฟังชื่อ ยกนิ้วเพื่อกด
   ============================================================ */

/**
 * ผูกปุ่มให้ประกาศชื่อเมื่อนิ้วแตะ และทำงานเมื่อยกนิ้วบนปุ่ม
 * ถ้าเลื่อนนิ้วออกนอกปุ่มก่อนยก จะถือว่ายกเลิก
 */
function bindButton(el, label, action) {
  let inside = false;

  el.addEventListener("touchstart", e => {
    e.preventDefault();
    inside = true;
    buzz("hover");
    speak(label, true);          // ฟังชื่อปุ่มก่อน ยังไม่ทำงาน
  }, { passive: false });

  el.addEventListener("touchmove", e => {
    const t = e.touches[0];
    const r = el.getBoundingClientRect();
    inside = t.clientX >= r.left && t.clientX <= r.right
          && t.clientY >= r.top  && t.clientY <= r.bottom;
  }, { passive: true });

  el.addEventListener("touchend", e => {
    e.preventDefault();
    if (inside) action();
  }, { passive: false });

  // สำหรับเมาส์บนคอมพิวเตอร์ และสำหรับ TalkBack ที่ส่ง click มาโดยตรง
  el.addEventListener("click", e => { if (e.detail !== 0 || !("ontouchstart" in window)) action(); });
}

function doStop() {
  running = false;
  clearTimeout(detectTimer);
  stopCamera();
  started = false;
  startLayer.style.display = "flex";
  document.getElementById("controls").style.display = "none";
  buzz("toggle");
  speak("หยุดการทำงานแล้ว แตะที่ใดก็ได้เพื่อเริ่มใหม่", true);
}

function doAuto() {
  autoMode = !autoMode;
  btnAuto.textContent = autoMode ? "อัตโนมัติ: เปิด" : "อัตโนมัติ: ปิด";
  btnAuto.setAttribute("aria-pressed", autoMode ? "true" : "false");
  btnAuto.classList.toggle("on", autoMode);
  lastSpoken = {};
  buzz("toggle");
  speak(autoMode ? MESSAGES.autoOn : MESSAGES.autoOff, true);
}

function doHelp() {
  buzz("toggle");
  speakLines(MESSAGES.tutorial, true);
}

/** วนสลับโหมดถัดไป โหลดโมเดลใหม่ถ้ายังไม่เคยโหลด */
async function doMode() {
  if (!running) return;
  buzz("toggle");
  modeIndex = (modeIndex + 1) % MODES.length;
  const mode = currentMode();
  btnMode.textContent = mode.label;
  btnMode.setAttribute("aria-label", "โหมดปัจจุบันคือ " + mode.label);

  speak(mode.label, true);
  if (!modelCache[mode.id]) speak("กำลังโหลดโมเดล กรุณารอสักครู่");

  try { model = await loadModelFor(mode); }
  catch (e) {
    console.error(e); buzz("error");
    speak("โหลดโมเดลไม่สำเร็จ กลับไปใช้โหมดเดิม", true);
    modeIndex = (modeIndex - 1 + MODES.length) % MODES.length;
    model = modelCache[currentMode().id];
    btnMode.textContent = currentMode().label;
    return;
  }

  lastSpoken = {}; lastClassName = ""; currentDetections = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  speak(mode.say);
}

bindButton(btnMode, MESSAGES.btnMode, doMode);
bindButton(btnStop, MESSAGES.btnStop, doStop);
bindButton(btnAuto, MESSAGES.btnAuto, doAuto);
bindButton(btnHelp, MESSAGES.btnHelp, doHelp);

// แตะบริเวณกล้อง = บอกสิ่งที่เห็นตอนนี้
tapArea.addEventListener("click", () => { if (running) announceNow(); });

/* ============================================================
   8. กันจอดับระหว่างใช้งาน
   ============================================================ */
let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) keepAwake();
});
startLayer.addEventListener("click", keepAwake);
