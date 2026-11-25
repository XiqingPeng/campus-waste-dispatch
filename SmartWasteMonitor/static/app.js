"use strict";

const byId = id => document.getElementById(id);
const stateLabels = {
  WAITING: ["等待/重连", "observe"], ONLINE: ["已连接", "online"],
  ERROR: ["处理错误", "alert"], PAUSED: ["已暂停", "observe"], FINISHED: ["回放结束", ""],
  NORMAL: ["正常", "online"], CHECKING: ["满载确认中", "observe"],
  FULL: ["已满载", "alert"], UNKNOWN: ["无法判断", "observe"]
};
const reviewLabels = {suspected:"待审核", confirmed:"已确认", rejected:"误报"};
const taskLabels = {pending:"等待清理", awaiting_verification:"待视觉复核", completed:"已复位"};
const colors = {mouth:"#6ec9ff", interior:"#87eea9", band:"#ffdd7c"};
const cameraSelect = byId("camera-index");
for (let i = 0; i < 16; i += 1) {
  cameraSelect.add(new Option("设备 " + i, String(i)));
}
let token = "";
let state = null;
let signature = "";
let version = null;
let preference = null;
let selected = "mouth";
let regions = {mouth:[], interior:[], band:[]};
let lastHistory = "";
let lastRefKey = "";
let frameInFlight = false;
let frameNeedsLoad = false;
const calibration = byId("calibration");
const canvas = byId("canvas");
const image = byId("frame");
const c = canvas.getContext("2d");

function setBadge(id, code) {
  const [name, style] = stateLabels[code] || ["—", ""];
  const node = byId(id);
  node.textContent = name;
  node.className = "badge " + style;
}

function feedback(message, error = false) {
  const node = byId("feedback");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error", error);
}

async function readJson(path, params) {
  const response = await fetch(path, params);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "输入格式无效，请检查标定或设备信息。");
  }
  return data;
}

function utc(value) {
  return value ? new Date(value).toLocaleString("zh-CN", {hour12:false}) : "—";
}

function ready() {
  return state && state.device && (state.state === "ONLINE" || state.state === "PAUSED");
}

function currentSource() {
  if (!ready()) throw new Error("请先等待有效画面。");
  return {device:state.device, epoch:state.reference_epoch};
}

async function post(url, body = {}, message = "操作已保存。") {
  if (!token) token = (await readJson("/api/session")).token;
  const result = await readJson(url, {
    method:"POST", headers:{"Content-Type":"application/json","X-Monitor-Token":token},
    body:JSON.stringify(body)
  });
  feedback(message);
  await refreshState();
  return result;
}

function onClick(id, action) {
  byId(id).addEventListener("click", async () => {
    const button = byId(id);
    try {
      button.disabled = true;
      await action();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      button.disabled = false;
      updateButtons();
    }
  });
}

function updateButtons() {
  const editable = Boolean(ready());
  for (const name of ["empty-ref", "full-ref", "save-calibration", "manual", "clear-region", "undo-point"]) {
    byId(name).disabled = !editable;
  }
  byId("clean").disabled = !state?.active_fullness || Boolean(state.active_fullness.cleaning_reported_at);
  canvas.classList.toggle("editing", calibration.open && editable && !image.hidden);
}

function updateReferencePreviews() {
  const desired = state.reference_epoch + ":" + state.references.join(",");
  if (desired === lastRefKey) return;
  lastRefKey = desired;
  for (const kind of ["empty","full"]) {
    const node = byId(kind + "-preview");
    node.hidden = !state.references.includes(kind);
    if (!node.hidden) node.src = "/api/reference/" + kind + ".jpg?t=" + Date.now();
  }
}

async function refreshState() {
  state = await readJson("/api/state");
  const test = state.mode !== "live";
  byId("mode").className = test ? "mode test" : "mode";
  byId("mode").textContent = {live:"实时相机", demo:"无摄像头演示", replay:"录像测试"}[state.mode];
  byId("test-overlay").hidden = !test || !state.has_preview;
  byId("hardware-controls").hidden = test;
  byId("replay-controls").hidden = !test;
  byId("pause").textContent = state.paused ? "继续回放" : "暂停回放";
  byId("stream-detail").textContent = state.calibration_error || state.message;
  byId("bin-label").textContent = state.calibration?.label || "未标定";
  byId("full-detail").textContent = state.fullness.detail;
  byId("full-time").textContent = utc(state.active_fullness?.confirmed_at);
  byId("seen").textContent = utc(state.last_seen_at);
  byId("hand-warning").hidden = !state.hand_error;
  byId("hand-warning").textContent = state.hand_error || "";
  byId("clean-note").textContent = state.active_fullness?.cleaning_reported_at
    ? "已登记清理。正在等待视觉复核。"
    : "清理后可在此登记。连续确认桶已清空后，状态会恢复正常。";
  setBadge("connection", state.state);
  setBadge("full-state", state.fullness.state);
  if (state.camera_preference !== preference) {
    preference = state.camera_preference;
    cameraSelect.value = preference || "auto";
  }
  if (state.device !== signature || state.calibration?.version !== version) {
    signature = state.device;
    version = state.calibration?.version;
    regions = state.calibration?.regions ? structuredClone(state.calibration.regions)
      : {mouth:[], interior:[], band:[]};
    byId("label").value = state.calibration?.label || "BIN-01";
    draw();
  }
  updateReferencePreviews();
  updateButtons();
  if (state.has_preview && image.hidden) frameNeedsLoad = true;
  if (!state.has_preview) {
    image.hidden = true;
    byId("placeholder").hidden = false;
    draw();
  }
}

function fetchFrame() {
  if (!state?.has_preview || frameInFlight ||
      (!frameNeedsLoad && state.state !== "ONLINE")) return;
  frameNeedsLoad = false;
  frameInFlight = true;
  image.src = "/api/frame.jpg?t=" + Date.now();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  if (image.hidden) return;
  for (const [key, points] of Object.entries(regions)) {
    if (!points.length) continue;
    c.strokeStyle = colors[key];
    c.fillStyle = colors[key];
    c.lineWidth = selected === key && calibration.open ? 2.7 : 1.8;
    c.setLineDash(key === "band" ? [6,5] : []);
    c.beginPath();
    points.forEach(([x,y], i) => i === 0 ? c.moveTo(x*canvas.width,y*canvas.height)
      : c.lineTo(x*canvas.width,y*canvas.height));
    if (points.length > 2) c.closePath();
    c.stroke();
    if (calibration.open) {
      c.setLineDash([]);
      for (const [x, y] of points) {
        c.beginPath();
        c.arc(x*canvas.width,y*canvas.height,3,0,Math.PI*2);
        c.fill();
      }
    }
  }
}

image.addEventListener("load", () => {
  frameInFlight = false;
  image.hidden = false;
  byId("placeholder").hidden = true;
  updateButtons();
  draw();
});
image.addEventListener("error", () => { frameInFlight = false; });
new ResizeObserver(() => draw()).observe(byId("image-wrap"));
calibration.addEventListener("toggle", () => { updateButtons(); draw(); });
canvas.addEventListener("click", event => {
  if (!calibration.open || !ready()) return;
  const box = canvas.getBoundingClientRect();
  if (regions[selected].length >= 24) return feedback("当前区域最多可以标 24 个点。", true);
  regions[selected].push([(event.clientX-box.left)/box.width, (event.clientY-box.top)/box.height]);
  draw();
});
function selectRegion(key) {
  selected = key;
  for (const button of document.querySelectorAll("button[data-region]")) {
    const chosen = button.dataset.region === key;
    button.classList.toggle("selected", chosen);
    button.setAttribute("aria-pressed", chosen ? "true" : "false");
  }
  draw();
}
for (const button of document.querySelectorAll("button[data-region]")) {
  button.addEventListener("click", () => selectRegion(button.dataset.region));
}
selectRegion("mouth");

onClick("undo-point", () => { regions[selected].pop(); draw(); });
onClick("clear-region", () => { regions[selected] = []; draw(); });
onClick("switch-camera", () => post("/api/camera", {
  index:cameraSelect.value === "auto" ? null : Number(cameraSelect.value)
}, "已应用设备选择，正在连接。"));
onClick("pause", () => post("/api/replay", {action:state?.paused ? "resume" : "pause"},
                            state?.paused ? "继续播放。" : "回放已暂停。"));
onClick("restart", () => post("/api/replay", {action:"restart"}, "已请求从头播放。"));
for (const id of ["empty","full"]) {
  onClick(id+"-ref", async () => {
    await post("/api/reference/"+id, currentSource(), id === "empty" ? "已采集空桶参考图。" : "已采集接近满载参考图。");
    const node = byId(id+"-preview");
    node.src = "/api/reference/" + id + ".jpg?t=" + Date.now();
    node.hidden = false;
  });
}
onClick("save-calibration", () => {
  const label = byId("label").value.trim();
  if (!label) throw new Error("请填写桶号。");
  if (Object.values(regions).some(points => points.length < 3)) throw new Error("请画出三个区域。");
  return post("/api/calibrate", {...currentSource(), label, regions}, "标定已保存，开始监测。");
});
onClick("manual", async () => {
  await post("/api/manual-capture", currentSource(), "测试抓拍已保存到投放记录。");
  await refreshHistory();
});
onClick("clean", () => post("/api/fullness/" + state.active_fullness.id + "/cleaned", {},
                            "已登记清理，等待摄像头复核。"));

function addText(parent, tag, content, css = "") {
  const el = document.createElement(tag);
  el.textContent = content;
  if (css) el.className = css;
  parent.append(el);
  return el;
}

function renderDrops(rows) {
  const root = byId("drops");
  root.replaceChildren();
  if (!rows.length) addText(root, "p", "暂无投放记录。", "muted");
  for (const row of rows) {
    const item = addText(root,"div","","drop-row");
    const pics = addText(item,"div","","drop-images");
    row.photos.forEach((_, i) => {
      const link = document.createElement("a");
      link.href = "/api/photo/" + row.id + "/" + i + ".jpg";
      link.target = "_blank";
      link.rel = "noopener";
      const thumb = document.createElement("img");
      thumb.src = link.href;
      thumb.alt = i === 0 ? "投放主图" : "投放备用图 " + i;
      thumb.loading = "lazy";
      link.append(thumb);
      pics.append(link);
    });
    const info = addText(item,"div","","drop_info");
    addText(info,"strong","#" + row.id + " · " + row.label + " · " + utc(row.occurred_at));
    addText(info,"p",reviewLabels[row.review] + (row.category ? " · "+row.category : "") + " ｜ " + row.evidence);
    const actions = addText(info,"div","","actions");
    const category = document.createElement("select");
    category.setAttribute("aria-label","垃圾类别");
    for (const [value, label] of [["","选择类别"],...["可回收物","厨余垃圾","有害垃圾","其他垃圾","无法判断"].map(v=>[v,v])]) {
      category.add(new Option(label,value));
    }
    category.value = row.category || "";
    actions.append(category);
    for (const [status,label] of [["confirmed","确认投放"],["rejected","标为误报"]]) {
      const button = addText(actions,"button",label);
      button.type = "button";
      button.addEventListener("click",async () => {
        try {
          button.disabled = true;
          await post("/api/review/" + row.id, {status, category:category.value || null},"审核记录已保存。");
          await refreshHistory();
        } catch (error) { feedback(error.message,true); }
        finally { button.disabled = false; }
      });
    }
  }
}

function renderFullness(rows) {
  const root = byId("full-history");
  root.replaceChildren();
  if (!rows.length) {
    const td = addText(addText(root,"tr",""),"td","暂无满载记录。");
    td.colSpan = 6;
  }
  for (const row of rows) {
    const tr = addText(root,"tr","");
    for (const value of ["#" + row.id,row.label,utc(row.first_seen_at),utc(row.confirmed_at),
                         utc(row.resolved_at),taskLabels[row.task_status]]) addText(tr,"td",value);
  }
}

async function refreshHistory() {
  const history = await readJson("/api/history");
  const value = JSON.stringify(history);
  if (value === lastHistory) return;
  lastHistory = value;
  renderDrops(history.drops);
  renderFullness(history.fullness);
}

async function watch() {
  try {
    await refreshState();
    await refreshHistory();
    fetchFrame();
  } catch (error) {
    setBadge("connection", "ERROR");
    byId("stream-detail").textContent = "无法读取本机服务。请检查程序窗口。";
  } finally {
    setTimeout(watch, 1500);
  }
}

setInterval(fetchFrame, 420);
watch();
