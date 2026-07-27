const MIN_DB = 30;
const MAX_DB = 110;
const HISTORY_MS = 60000;
const MICROPHONE_TIMEOUT_MS = 15000;
const STORAGE_KEY = "morning-reading-volume";

const elements = {
  dbValue: document.querySelector("#dbValue"),
  micStatus: document.querySelector("#micStatus"),
  levelLabel: document.querySelector("#levelLabel"),
  targetRange: document.querySelector("#targetRange"),
  targetBand: document.querySelector("#targetBand"),
  levelBar: document.querySelector("#levelBar"),
  historyCanvas: document.querySelector("#historyCanvas"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  avgValue: document.querySelector("#avgValue"),
  peakValue: document.querySelector("#peakValue"),
  passValue: document.querySelector("#passValue"),
  streakValue: document.querySelector("#streakValue"),
  minTarget: document.querySelector("#minTarget"),
  maxTarget: document.querySelector("#maxTarget"),
  calibrationOffset: document.querySelector("#calibrationOffset"),
  minTargetText: document.querySelector("#minTargetText"),
  maxTargetText: document.querySelector("#maxTargetText"),
  calibrationText: document.querySelector("#calibrationText"),
  referenceDb: document.querySelector("#referenceDb"),
  calibrateButton: document.querySelector("#calibrateButton"),
  note: document.querySelector("#note"),
};

let audioContext;
let analyser;
let microphoneStream;
let animationFrame = 0;
let samples;
let smoothedDb = null;
let latestDbfs = null;
let history = [];
let settings = loadSettings();

elements.minTarget.value = settings.minTarget;
elements.maxTarget.value = settings.maxTarget;
elements.calibrationOffset.value = settings.calibrationOffset;

updateTargetControls();
drawHistory(performance.now());

elements.startButton.addEventListener("click", startListening);
elements.stopButton.addEventListener("click", stopListening);
elements.calibrateButton.addEventListener("click", calibrateToReference);

for (const control of [elements.minTarget, elements.maxTarget, elements.calibrationOffset]) {
  control.addEventListener("input", () => {
    settings.minTarget = Number(elements.minTarget.value);
    settings.maxTarget = Number(elements.maxTarget.value);
    settings.calibrationOffset = Number(elements.calibrationOffset.value);
    enforceTargetOrder(control);
    saveSettings();
    updateTargetControls();
    drawHistory(performance.now());
  });
}

window.addEventListener("resize", () => drawHistory(performance.now()));

async function startListening() {
  if (!window.isSecureContext) {
    setStatus("非安全页面", "error");
    elements.note.textContent = "麦克风访问需要 HTTPS。请使用 GitHub Pages 的 https:// 地址打开。";
    return;
  }

  const getMedia = getUserMediaHandler();
  if (!getMedia) {
    setStatus("不支持", "error");
    elements.note.textContent = "当前浏览器没有开放麦克风 API。请用 Chrome、Edge 或 Safari 直接打开 GitHub Pages 链接，不要在微信/QQ等内置浏览器里打开。";
    return;
  }

  try {
    elements.startButton.disabled = true;
    setStatus("连接中", "");
    elements.note.textContent = "正在请求麦克风权限。如果浏览器弹出权限提示，请选择允许。";

    microphoneStream = await requestMicrophoneStream(getMedia, {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;

    const source = audioContext.createMediaStreamSource(microphoneStream);
    source.connect(analyser);

    samples = new Float32Array(analyser.fftSize);
    history = [];
    smoothedDb = null;
    setStatus("监听中", "live");
    elements.stopButton.disabled = false;
    elements.calibrateButton.disabled = false;
    elements.note.textContent = "当前值为估算分贝，校准后会更接近现场读书音量。";
    tick(performance.now());
  } catch (error) {
    stopListening({ keepMessage: true });
    const errorName = error && error.name;
    const denied = errorName === "NotAllowedError" || errorName === "SecurityError";
    setStatus(denied ? "未授权" : "失败", "error");
    elements.note.textContent = getMicrophoneErrorMessage(errorName);
  } finally {
    if (!microphoneStream) {
      elements.startButton.disabled = false;
    }
  }
}

function getUserMediaHandler() {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    return (constraints) => navigator.mediaDevices.getUserMedia(constraints);
  }

  const legacyGetUserMedia =
    navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia;

  if (!legacyGetUserMedia) {
    return null;
  }

  return (constraints) =>
    new Promise((resolve, reject) => {
      legacyGetUserMedia.call(navigator, constraints, resolve, reject);
    });
}

function requestMicrophoneStream(getMedia, constraints) {
  let timedOut = false;
  const request = getMedia(constraints);

  const timeout = new Promise((resolve, reject) => {
    window.setTimeout(() => {
      timedOut = true;
      const error = new Error("Microphone permission prompt timed out");
      error.name = "PermissionTimeoutError";
      reject(error);
    }, MICROPHONE_TIMEOUT_MS);
  });

  request.then((stream) => {
    if (timedOut) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }).catch(() => {});

  return Promise.race([request, timeout]);
}

function getMicrophoneErrorMessage(errorName) {
  if (errorName === "PermissionTimeoutError") {
    return "麦克风权限请求没有返回。请检查地址栏左侧的站点权限，允许 github.io 使用麦克风后刷新页面。";
  }

  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return "麦克风权限被浏览器或当前站点阻止。请在地址栏左侧的站点设置中允许麦克风，然后刷新页面。";
  }

  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "浏览器没有找到可用麦克风。请确认系统输入设备已启用。";
  }

  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "麦克风已被其他程序占用，或浏览器暂时无法读取设备。请关闭占用麦克风的软件后重试。";
  }

  if (errorName === "OverconstrainedError" || errorName === "ConstraintNotSatisfiedError") {
    return "当前麦克风不满足浏览器请求条件。请换一个浏览器或设备重试。";
  }

  return `麦克风连接失败${errorName ? `（${errorName}）` : ""}。请换用 Chrome、Edge 或 Safari 直接打开 GitHub Pages 链接重试。`;
}

function stopListening(options = {}) {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;

  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) {
      track.stop();
    }
  }

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
  }

  microphoneStream = null;
  audioContext = null;
  analyser = null;
  samples = null;
  smoothedDb = null;
  latestDbfs = null;

  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  elements.calibrateButton.disabled = true;

  if (!options.keepMessage) {
    setStatus("未监听", "");
    elements.levelLabel.textContent = "等待麦克风";
    elements.dbValue.textContent = "--";
    elements.levelBar.style.width = "0%";
  }
}

function tick(now) {
  if (!analyser || !samples) return;

  analyser.getFloatTimeDomainData(samples);
  const dbfs = calculateDbfs(samples);
  latestDbfs = dbfs;

  const estimatedDb = clamp(dbfs + settings.calibrationOffset, MIN_DB, 120);
  smoothedDb = smoothedDb === null ? estimatedDb : smoothedDb * 0.78 + estimatedDb * 0.22;

  history.push({ time: now, db: smoothedDb });
  history = history.filter((item) => now - item.time <= HISTORY_MS);

  updateReadout(smoothedDb);
  updateStats(now);
  drawHistory(now);

  animationFrame = requestAnimationFrame(tick);
}

function calculateDbfs(buffer) {
  let sumSquares = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    sumSquares += buffer[index] * buffer[index];
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  return 20 * Math.log10(Math.max(rms, 0.00001));
}

function updateReadout(db) {
  const rounded = Math.round(db);
  const percent = dbToPercent(db);
  elements.dbValue.textContent = String(rounded);
  elements.levelBar.style.width = `${percent}%`;

  const state = getVolumeState(db);
  elements.levelLabel.textContent = state.label;
  elements.levelLabel.style.color = state.color;
}

function getVolumeState(db) {
  if (db < settings.minTarget - 8) {
    return { label: "声音偏低", color: "var(--amber)" };
  }

  if (db < settings.minTarget) {
    return { label: "接近目标", color: "var(--amber)" };
  }

  if (db <= settings.maxTarget) {
    return { label: "早读达标", color: "var(--green)" };
  }

  return { label: "音量过响", color: "var(--red)" };
}

function updateStats(now) {
  if (!history.length) {
    return;
  }

  const values = history.map((item) => item.db);
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const peak = Math.max(...values);
  const passed = values.filter((value) => value >= settings.minTarget && value <= settings.maxTarget).length;
  const passRate = Math.round((passed / values.length) * 100);
  const streak = getCurrentStreak(now);

  elements.avgValue.textContent = `${Math.round(average)} dB`;
  elements.peakValue.textContent = `${Math.round(peak)} dB`;
  elements.passValue.textContent = `${passRate}%`;
  elements.streakValue.textContent = formatSeconds(streak);
}

function getCurrentStreak(now) {
  let start = now;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = history[index].db;
    if (value < settings.minTarget || value > settings.maxTarget) {
      break;
    }
    start = history[index].time;
  }

  return Math.max(0, Math.round((now - start) / 1000));
}

function drawHistory(now) {
  const canvas = elements.historyCanvas;
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(pixelRatio, pixelRatio);

  const cssWidth = width / pixelRatio;
  const cssHeight = height / pixelRatio;
  paintCanvasBackground(ctx, cssWidth, cssHeight);
  paintTargetZone(ctx, cssWidth, cssHeight);
  paintHistoryLine(ctx, cssWidth, cssHeight, now);

  ctx.restore();
}

function paintCanvasBackground(ctx, width, height) {
  ctx.fillStyle = "#fbfcfa";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#e2e7e2";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "#7a807c";

  for (const db of [40, 60, 80, 100]) {
    const y = dbToY(db, height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 10, y - 6);
  }
}

function paintTargetZone(ctx, width, height) {
  const top = dbToY(settings.maxTarget, height);
  const bottom = dbToY(settings.minTarget, height);
  ctx.fillStyle = "rgba(47, 143, 85, 0.12)";
  ctx.fillRect(0, top, width, bottom - top);
}

function paintHistoryLine(ctx, width, height, now) {
  if (history.length < 2) {
    ctx.fillStyle = "#7a807c";
    ctx.fillText("0s", width - 30, height - 12);
    return;
  }

  ctx.beginPath();
  history.forEach((item, index) => {
    const x = width - ((now - item.time) / HISTORY_MS) * width;
    const y = dbToY(item.db, height);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.strokeStyle = "#227c8a";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const latest = history[history.length - 1];
  if (latest) {
    const x = width - ((now - latest.time) / HISTORY_MS) * width;
    const y = dbToY(latest.db, height);
    ctx.fillStyle = "#29302d";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = "#7a807c";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("-60s", 10, height - 12);
  ctx.fillText("0s", width - 30, height - 12);
}

function calibrateToReference() {
  if (latestDbfs === null) return;

  const reference = clamp(Number(elements.referenceDb.value) || 70, MIN_DB, 120);
  settings.calibrationOffset = Math.round(reference - latestDbfs);
  settings.calibrationOffset = clamp(settings.calibrationOffset, 60, 125);
  elements.calibrationOffset.value = settings.calibrationOffset;
  saveSettings();
  updateTargetControls();
}

function enforceTargetOrder(changedControl) {
  const minimum = Number(elements.minTarget.value);
  const maximum = Number(elements.maxTarget.value);

  if (minimum >= maximum) {
    if (changedControl === elements.minTarget) {
      settings.maxTarget = Math.min(110, minimum + 1);
      elements.maxTarget.value = settings.maxTarget;
    } else {
      settings.minTarget = Math.max(35, maximum - 1);
      elements.minTarget.value = settings.minTarget;
    }
  }
}

function updateTargetControls() {
  settings.minTarget = Number(elements.minTarget.value);
  settings.maxTarget = Number(elements.maxTarget.value);
  settings.calibrationOffset = Number(elements.calibrationOffset.value);

  elements.minTargetText.textContent = `${settings.minTarget} dB`;
  elements.maxTargetText.textContent = `${settings.maxTarget} dB`;
  elements.calibrationText.textContent = `${settings.calibrationOffset} dB`;
  elements.targetRange.textContent = `${settings.minTarget} - ${settings.maxTarget} dB`;

  const start = dbToPercent(settings.minTarget);
  const end = dbToPercent(settings.maxTarget);
  elements.targetBand.style.left = `${start}%`;
  elements.targetBand.style.width = `${Math.max(0, end - start)}%`;
}

function dbToPercent(db) {
  return clamp(((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100, 0, 100);
}

function dbToY(db, height) {
  return height - (dbToPercent(db) / 100) * height;
}

function setStatus(text, variant) {
  elements.micStatus.textContent = text;
  elements.micStatus.classList.toggle("is-live", variant === "live");
  elements.micStatus.classList.toggle("is-error", variant === "error");
}

function formatSeconds(value) {
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds}s`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      minTarget: Number(saved.minTarget) || 60,
      maxTarget: Number(saved.maxTarget) || 80,
      calibrationOffset: Number(saved.calibrationOffset) || 94,
    };
  } catch {
    return {
      minTarget: 60,
      maxTarget: 80,
      calibrationOffset: 94,
    };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
