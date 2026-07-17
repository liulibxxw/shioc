/* ==========================================================
   人设档案馆 · 页面渲染 + 编辑模式
   （内容默认值在 js/data.js；页面里的修改保存在浏览器本地，
     可通过编辑工具栏「导出 data.js」永久保存）
   ========================================================== */

/* ---------- 数据 ---------- */
const DEFAULT_DATA = {
  site: SITE,
  characters: CHARACTERS,
  relationships: RELATIONSHIPS,
  worldviews: WORLDVIEWS,
};

const DATA_VER = typeof DATA_VERSION === "undefined" ? "0" : DATA_VERSION;

function freshData() {
  const d = JSON.parse(JSON.stringify(DEFAULT_DATA));
  d.__v = DATA_VER;
  return d;
}

function loadData() {
  try {
    const s = localStorage.getItem("oc-data");
    if (s) {
      const obj = JSON.parse(s);
      if (obj && obj.__v === DATA_VER) return obj;
      /* data.js 已更新版本：丢弃浏览器里缓存的旧数据 */
      localStorage.removeItem("oc-data");
    }
  } catch (e) { /* 数据损坏则回退默认 */ }
  return freshData();
}

let DATA = loadData();
let EDIT = localStorage.getItem("oc-edit") === "1";
let PAGE = "home";

/* 仅写入当前浏览器本地（不触发线上同步）；用于拉取线上数据后回写缓存 */
function saveDataLocal() {
  localStorage.setItem("oc-data", JSON.stringify(DATA));
}
/* 保存：写本地缓存，并在编辑模式 + 已配置同步密钥时推送到线上 */
function saveData() {
  saveDataLocal();
  schedulePush();
}

/* ==========================================================
   线上数据同步（Cloudflare Worker + KV）
   · 加载时从 /api/data 拉取线上数据，作为所有访客看到的内容
   · 编辑保存时（带同步密钥）自动推送到 /api/data，令所有访客刷新即可看到最新内容
   同步密钥只保存在编辑者本机浏览器，随请求头发送，不写入仓库、也不随导出文件外泄。
   ========================================================== */
const SYNC_KEY_STORE = "oc-sync-key";
const SYNC = {
  enabled: false,   // 线上同步是否可用（Worker + KV 已部署）
  claimed: false,   // 线上是否已设定过口令（首次设定后为 true）
  status: "idle",   // idle | syncing | ok | err | off
  rev: 0,
  msg: "",
  _timer: null,
};

function syncGetKey() { try { return localStorage.getItem(SYNC_KEY_STORE) || ""; } catch (e) { return ""; } }
function syncSetKey(k) {
  try { k ? localStorage.setItem(SYNC_KEY_STORE, k) : localStorage.removeItem(SYNC_KEY_STORE); } catch (e) { /* ignore */ }
}

/* 读取一个同源 JSON 接口；非 JSON / 出错返回 null（兼容无后端的纯静态站） */
async function syncFetchJSON(path, opts) {
  try {
    const res = await fetch(path, Object.assign({ headers: { accept: "application/json" }, cache: "no-store" }, opts || {}));
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("application/json")) return null;
    return await res.json();
  } catch (e) { return null; }
}

/* 向服务器校验口令；返回 "ok" | "invalid" | "off" | "neterr" */
async function syncVerifyKey(key) {
  const b = await syncFetchJSON("/api/verify", { headers: { "x-edit-key": key, accept: "application/json" } });
  if (b === null) return "neterr";
  if (!b.enabled) return "off";
  return b.valid ? "ok" : "invalid";
}

/* 拉取线上数据；成功替换 DATA 返回 true，否则返回 false */
async function syncPull() {
  const st = await syncFetchJSON("/api/status");
  if (!st || !st.enabled) { SYNC.enabled = false; return false; }
  SYNC.enabled = true;
  SYNC.claimed = !!st.claimed;
  const body = await syncFetchJSON("/api/data");
  if (!body || !body.enabled) return false;
  SYNC.rev = body.rev || 0;
  const d = body.data;
  if (d && d.site && Array.isArray(d.characters) && Array.isArray(d.relationships) && Array.isArray(d.worldviews)) {
    /* 线上数据是所有访客看到的权威内容，无视本地版本号直接采用 */
    DATA = { site: d.site, characters: d.characters, relationships: d.relationships, worldviews: d.worldviews, __v: DATA_VER };
    try { saveDataLocal(); } catch (e) { /* 本地空间不足则仅内存生效 */ }
    SYNC.claimed = true;
    if (SYNC.status !== "err") SYNC.status = "ok";
    return true;
  }
  return false;
}

/* 编辑保存后防抖推送到线上 */
function schedulePush() {
  if (!(EDIT && SYNC.enabled && syncGetKey())) return;
  SYNC.status = "syncing"; paintSyncPill();
  clearTimeout(SYNC._timer);
  SYNC._timer = setTimeout(pushNow, 900);
}

/* 立即推送当前数据到线上；返回 { ok, error } */
async function pushNow() {
  const key = syncGetKey();
  if (!key) return { ok: false, error: "未设置同步密钥" };
  if (!SYNC.enabled) return { ok: false, error: "线上同步未启用" };
  SYNC.status = "syncing"; SYNC.msg = ""; paintSyncPill();
  let res;
  try {
    res = await fetch("/api/data", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-edit-key": key },
      body: JSON.stringify({ data: { site: DATA.site, characters: DATA.characters, relationships: DATA.relationships, worldviews: DATA.worldviews } }),
    });
  } catch (e) {
    SYNC.status = "err"; SYNC.msg = "网络错误"; paintSyncPill();
    return { ok: false, error: "网络错误，请稍后重试" };
  }
  if (!res.ok) {
    let m = res.status === 401 ? "同步密钥不正确" : "保存失败";
    try { const b = await res.json(); if (b && b.error) m = b.error; } catch (e) { /* ignore */ }
    SYNC.status = "err"; SYNC.msg = m; paintSyncPill();
    return { ok: false, error: m };
  }
  try { const b = await res.json(); SYNC.rev = b.rev || SYNC.rev; } catch (e) { /* ignore */ }
  SYNC.status = "ok"; SYNC.msg = ""; paintSyncPill();
  return { ok: true };
}

/* 删除等「保存后立即跳转」的破坏性操作专用：先落盘，取消防抖定时器并立即把最新数据
   推送到线上，推送结束（无论成败）后再执行 after（通常是 location.href 跳转）。
   若不这样做，schedulePush 的 900ms 防抖会被随后的页面跳转打断，删除未同步到线上，
   下次 syncPull 拉回旧数据即造成被删除的条目「复活」。 */
function saveDataThen(after) {
  saveDataLocal();
  clearTimeout(SYNC._timer);
  if (EDIT && SYNC.enabled && syncGetKey()) {
    pushNow().finally(after);
  } else {
    after();
  }
}

/* 工具栏同步状态胶囊 */
function syncPillHTML() {
  return `<button type="button" class="ep-open sync-pill" id="syncPill"><span class="sp-body">☁ 线上同步</span></button>`;
}
function paintSyncPill() {
  const el = document.getElementById("syncPill");
  if (!el) return;
  const body = el.querySelector(".sp-body");
  let icon = "☁", txt = "线上同步", cls = "";
  if (!SYNC.enabled) { icon = "○"; txt = "本地模式"; cls = "off"; }
  else if (!syncGetKey()) { icon = "☁"; txt = "输入口令"; cls = "need"; }
  else if (SYNC.status === "syncing") { icon = "⟳"; txt = "同步中…"; cls = "syncing"; }
  else if (SYNC.status === "err") { icon = "⚠"; txt = "同步失败" + (SYNC.msg ? "：" + SYNC.msg : ""); cls = "err"; }
  else { icon = "☁"; txt = "已同步到线上"; cls = "ok"; }
  el.className = "ep-open sync-pill " + cls;
  if (body) body.textContent = icon + " " + txt;
}

/* 同步状态 / 口令面板：点击胶囊打开。用于查看状态、更换或清除本机口令并重新发布。
   （日常无需在此设置——进入编辑时输入的口令已自动用于同步。） */
function openSyncPanel() {
  if (!SYNC.enabled) {
    uiNotice("线上同步未启用：没有检测到 /api 服务。部署 Cloudflare Worker + KV 后，在此设备进入编辑输入口令即可自动同步。");
    return;
  }
  const curKey = syncGetKey();
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ui-dialog";
  wrap.innerHTML = `
    <div class="ae-panel ui-dialog-panel pw-panel">
      <div class="pw-title"><i class="fa-solid fa-cloud"></i> 线上同步口令</div>
      <div class="pw-desc">进入编辑时输入的口令会自动用于同步，一般无需在此设置。如果换了口令、或提示同步失败，可在此重新输入本机口令。口令只保存在本机浏览器，不会进入仓库。</div>
      <input type="password" class="ep-input sync-in" placeholder="编辑口令" autocomplete="off" value="${esc(curKey)}">
      <div class="pw-err" hidden></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel">取消</button>
        ${curKey ? `<button type="button" class="sync-clear ep-open tb-del">清除本机口令</button>` : ""}
        <button type="button" class="ae-ok">✔ 保存并发布</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector(".sync-in");
  const err = wrap.querySelector(".pw-err");
  const close = () => wrap.remove();
  const okBtn = wrap.querySelector(".ae-ok");
  const cancelBtn = wrap.querySelector(".ae-cancel");
  const clearBtn = wrap.querySelector(".sync-clear");
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  if (cancelBtn) cancelBtn.addEventListener("click", close);
  if (clearBtn) clearBtn.addEventListener("click", () => {
    syncSetKey(""); SYNC.status = "idle"; SYNC.msg = ""; paintSyncPill(); close();
    uiNotice("已清除本机口令。此后本设备的修改将不再自动发布到线上，重新输入口令即可恢复。");
  });
  const fail = (m) => { err.textContent = m; err.hidden = false; input.classList.add("err"); input.focus(); };
  input.addEventListener("input", () => { input.classList.remove("err"); err.hidden = true; });
  okBtn.addEventListener("click", async () => {
    const v = input.value.trim();
    if (!v) { fail("口令不能为空。"); return; }
    okBtn.disabled = true; okBtn.textContent = "验证中…";
    const vr = await syncVerifyKey(v);
    if (vr !== "ok") {
      okBtn.disabled = false; okBtn.textContent = "✔ 保存并发布";
      fail(vr === "invalid" ? "口令不正确。" : "线上服务不可用，请重试。");
      return;
    }
    syncSetKey(v); paintSyncPill();
    okBtn.textContent = "发布中…";
    const r = await pushNow();
    okBtn.disabled = false; okBtn.textContent = "✔ 保存并发布";
    if (!r.ok) { fail(r.error); return; }
    close();
    uiNotice("已发布到线上，所有访客刷新即可看到最新内容。");
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); okBtn.click(); } if (e.key === "Escape") close(); });
  input.focus();
}

/* ---------- 工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const charById = (id) => DATA.characters.find((c) => c.id === id);

function esc(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

/* 解析十六进制色值：# 可省略，支持 3 / 6 位写法，返回 #RRGGBB 或 null */
function parseHex(s) {
  if (!s) return null;
  let v = String(s).trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(v) ? "#" + v.toUpperCase() : null;
}

/* CP 名：# 是默认自带的装饰。存储只保留名字本体，展示时自动补上前后 # */
function hashCore(raw) {
  return String(raw == null ? "" : raw).trim().replace(/^#+/, "").replace(/#+$/, "").trim();
}
function hashLabel(raw) {
  const c = hashCore(raw);
  return c ? "#" + c + "#" : "";
}

/* 自绘提示 / 确认框（全程不使用浏览器原生 alert / confirm / prompt） */
function uiNotice(msg) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ui-dialog";
  wrap.innerHTML = `
    <div class="ae-panel ui-dialog-panel">
      <div class="ui-dialog-msg"></div>
      <div class="ae-actions">
        <button type="button" class="ae-ok ui-dialog-ok">知道了</button>
      </div>
    </div>`;
  wrap.querySelector(".ui-dialog-msg").textContent = msg;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector(".ui-dialog-ok").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
}
function uiConfirm(msg, onOk) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ui-dialog";
  wrap.innerHTML = `
    <div class="ae-panel ui-dialog-panel">
      <div class="ui-dialog-msg"></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel ui-dialog-cancel">取消</button>
        <button type="button" class="ae-ok ui-dialog-ok">确定</button>
      </div>
    </div>`;
  wrap.querySelector(".ui-dialog-msg").textContent = msg;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector(".ui-dialog-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector(".ui-dialog-ok").addEventListener("click", () => { close(); if (onOk) onOk(); });
}

/* ---------- 编辑模式鉴权 ----------
   统一为「一个口令」：进入编辑时输入，同一口令既解锁编辑、也用于把修改同步到线上。
   · 联网（部署了 Worker + KV）：口令由服务器校验，各设备填一致即可；首次输入即设定。
   · 离线（纯静态无后端）：退回本机密码校验（散列存本地），站点照常可用。
   口令只保存在本机浏览器（明文用于随请求头同步、或散列用于离线校验），
   不进入 GitHub 仓库、也不随「导出 data.js」外泄。同一浏览器验证过一次即被信任。 */
const EDIT_PASS_KEY = "oc-edit-pass";
const EDIT_TRUST_KEY = "oc-edit-trusted";   // 本浏览器已验证过口令的标记

function hashPass(s) {
  /* 双散列（FNV-1a + DJB2）加盐，同步无依赖；用于离线本地校验，不追求密码学强度 */
  const str = "oc::" + s + "::pass";
  let h1 = 0x811c9dc5, h2 = 0x1505;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/* 通用口令输入弹框。onSubmit(value, fail, close, okBtn) 自行决定校验与后续动作 */
function showPwDialog({ title, desc, confirm = false, okLabel = "✔ 确定", hint = "", onSubmit }) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ui-dialog";
  wrap.innerHTML = `
    <div class="ae-panel ui-dialog-panel pw-panel">
      <div class="pw-title"><i class="fa-solid fa-lock"></i> ${esc(title)}</div>
      <div class="pw-desc">${desc}</div>
      <input type="password" class="ep-input pw-in" placeholder="编辑口令" autocomplete="new-password">
      ${confirm ? `<input type="password" class="ep-input pw-in2" placeholder="再次输入确认" autocomplete="new-password">` : ""}
      <div class="pw-err" hidden></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel">取消</button>
        <button type="button" class="ae-ok">${esc(okLabel)}</button>
      </div>
      ${hint ? `<div class="pw-hint">${hint}</div>` : ""}
    </div>`;
  document.body.appendChild(wrap);
  const in1 = wrap.querySelector(".pw-in");
  const in2 = wrap.querySelector(".pw-in2");
  const err = wrap.querySelector(".pw-err");
  const okBtn = wrap.querySelector(".ae-ok");
  const close = () => wrap.remove();
  const fail = (msg) => { err.textContent = msg; err.hidden = false; in1.classList.add("err"); if (in2) in2.classList.add("err"); in1.focus(); };
  const submit = () => {
    const v = in1.value;
    if (!v) { fail("口令不能为空。"); return; }
    if (confirm && v !== (in2 ? in2.value : "")) { fail("两次输入的口令不一致。"); return; }
    onSubmit(v, fail, close, okBtn);
  };
  okBtn.addEventListener("click", submit);
  wrap.querySelector(".ae-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") close(); });
    inp.addEventListener("input", () => { inp.classList.remove("err"); err.hidden = true; });
  });
  in1.focus();
}

/* 进入编辑前的统一口令流程 */
function requestEditUnlock(onOk) {
  /* 同一浏览器已验证过 → 直接进入 */
  if (localStorage.getItem(EDIT_TRUST_KEY) === "1") { onOk(); return; }

  if (SYNC.enabled) {
    /* 联网：口令交服务器校验（未设定则本次即设定） */
    const setup = !SYNC.claimed;
    showPwDialog({
      title: setup ? "设置编辑口令" : "输入编辑口令",
      desc: setup
        ? "设置一个口令：用它进入编辑，并把修改同步到线上给所有访客。首次输入即设定，之后在任何设备填一致的口令即可编辑。口令只保存在本机浏览器，不进入仓库。"
        : "输入你的编辑口令即可进入编辑并同步。口令只保存在本机浏览器，不进入仓库。",
      confirm: setup,
      okLabel: setup ? "✔ 设置并进入" : "✔ 进入",
      hint: setup ? "" : "忘记口令：可在 Cloudflare KV 中删除 auth-hash 条目后重新设定。",
      onSubmit: async (v, fail, close, okBtn) => {
        okBtn.disabled = true; const orig = okBtn.textContent; okBtn.textContent = "验证中…";
        const r = await syncVerifyKey(v);
        okBtn.disabled = false; okBtn.textContent = orig;
        if (r === "invalid") { fail("口令不正确。"); return; }
        if (r !== "ok") { fail("线上服务不可用，请稍后重试。"); return; }
        syncSetKey(v);
        localStorage.setItem(EDIT_TRUST_KEY, "1");
        close(); onOk();
      },
    });
  } else {
    /* 离线：退回本机密码校验 */
    const saved = localStorage.getItem(EDIT_PASS_KEY);
    const setup = !saved;
    showPwDialog({
      title: setup ? "设置编辑口令" : "输入编辑口令",
      desc: setup
        ? "首次进入编辑模式，请设置一个口令（当前为离线本地模式，口令只保存在本机）。"
        : "请输入口令（离线本地模式，口令只保存在本机）。",
      confirm: setup,
      okLabel: setup ? "✔ 设置并进入" : "✔ 进入",
      hint: setup ? "" : "忘记口令：清除本站浏览器数据后可重新设置。",
      onSubmit: (v, fail, close) => {
        if (setup) localStorage.setItem(EDIT_PASS_KEY, hashPass(v));
        else if (hashPass(v) !== saved) { fail("口令不正确。"); return; }
        syncSetKey(v);   // 存起来，联网后即可直接用作同步口令
        localStorage.setItem(EDIT_TRUST_KEY, "1");
        close(); onOk();
      },
    });
  }
}

/* 打开某个实体编辑面板的按钮 */
function panelBtn(kind, idx, label = "编辑档案") {
  if (!EDIT) return "";
  return `<button type="button" class="ep-open" data-panel='${esc(JSON.stringify({ kind, idx }))}'><i class="fa-solid fa-pen-to-square"></i> ${esc(label)}</button>`;
}
/* 新增某类实体的按钮 */
function addEntityBtn(kind, label) {
  if (!EDIT) return "";
  return `<button type="button" class="ep-add" data-panel-add='${esc(JSON.stringify({ kind }))}'>＋ ${esc(label)}</button>`;
}

/* 头像：有图用图，没图生成「渐变底 + 首字」SVG */
function avatarHTML(ch) {
  let inner;
  if (ch.avatar) {
    inner = `<img src="${esc(ch.avatar)}" alt="${esc(ch.name)}">`;
  } else {
    const c1 = parseHex(ch.colors?.[0]?.hex) || "#75B596";
    const c2 = parseHex(ch.colors?.[1]?.hex) || "#438855";
    const uid = "g-" + Math.abs([...ch.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) + "-" + (ch.colors?.[0]?.hex || "").slice(1);
    inner = `<svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label="${esc(ch.name)}">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${esc(c1)}"/><stop offset="1" stop-color="${esc(c2)}"/>
      </linearGradient></defs>
      <rect width="100" height="100" fill="url(#${uid})"/>
      <text x="50" y="54" text-anchor="middle" dominant-baseline="middle"
        font-family="'Noto Serif SC',serif" font-size="40" font-weight="900"
        fill="rgba(255,255,255,0.92)">${esc(ch.name.slice(0, 1))}</text>
    </svg>`;
  }
  return `<span class="avatar-inner">${inner}</span>`;
}

/* 人物志段落：兼容纯文本与 { title, text } 两种写法（标题可留空） */
function paraOf(p) {
  if (p && typeof p === "object") return { title: p.title || "", text: p.text || "" };
  return { title: "", text: p == null ? "" : String(p) };
}
function paraHTML(p) {
  const { title, text } = paraOf(p);
  return `${title ? `<b class="para-title">${esc(title)}</b>` : ""}<span class="para-text">${esc(text)}</span>`;
}

/* ---------- CSS 变量读取工具 ---------- */
function cssColor(k) {
  return getComputedStyle(document.documentElement).getPropertyValue(k).trim() || "#ffffff";
}

/* ---------- 导航 / 页脚 / 工具栏 ---------- */
const NAV_LINKS = [
  ["index.html", "首页", "home", "01", "HOME"],
  ["character.html", "角色", "character", "02", "CAST"],
  ["relationship.html", "关系", "relationship", "03", "BONDS"],
  ["worldview.html", "世界观", "worldview", "04", "WORLD"],
];

function renderNav() {
  $("#nav").innerHTML = `
    <div class="nav-inner">
      <div class="nav-left">
        <a class="brand" href="index.html">
          <span class="brand-ghost" aria-hidden="true">OC</span>
          <span class="brand-txt">
            <span class="brand-en"><i>·</i>${esc(DATA.site.titleEn)}<i>·</i></span>
            <span class="brand-cn"><span class="q">「</span>${esc(DATA.site.title)}<span class="q">」</span></span>
          </span>
        </a>
        <div class="nav-actions">
          <button id="editToggle" class="icon-btn ${EDIT ? "editing-on" : ""}" type="button" title="${EDIT ? "完成编辑" : "进入编辑模式"}" aria-label="${EDIT ? "完成编辑" : "进入编辑模式"}"><i class="fa-solid ${EDIT ? "fa-check" : "fa-pen"}"></i></button>
        </div>
      </div>
    </div>`;
}

/* ---------- 书口插签（窄屏页面切换） ---------- */
function slipInner([, label, , no, en]) {
  return `
    <span class="rb-main">
      <span class="rb-txt">${label}</span>
      <span class="rb-rule"></span>
      <span class="rb-en" aria-hidden="true">${en}</span>
    </span>
    <span class="rb-code" aria-hidden="true"></span>
    <span class="rb-foot">
      <span class="rb-no">№ ${no}</span>
    </span>`;
}

/* 书签作为导航栏成员放在最右端，四张始终横向排开，导航栏高度由书签撑起 */
function renderPendant() {
  const old = $("#navPendant");
  if (old) old.remove();
  const host = $(".nav-inner");
  if (!host) return;
  const pend = document.createElement("nav");
  pend.id = "navPendant";
  pend.className = "nav-pendant";
  pend.setAttribute("aria-label", "页面切换书签");
  pend.innerHTML = NAV_LINKS.map((l) => {
    const cur = l[2] === PAGE;
    return `<a class="rb ${cur ? "rb-cur" : ""}" href="${l[0]}"${cur ? ' aria-current="page"' : ""}>${slipInner(l)}</a>`;
  }).join("");
  host.appendChild(pend);
}

function renderFooter() {
  $("#footer").innerHTML = `
    <div class="wrap">
      <span class="deco">◆</span><span>${esc(DATA.site.footer)}</span><span class="deco">◆</span>
      <div class="footer-sign">
        <span class="fs-main"><i class="br">{</i> 由 琉璃 设计 <i class="br">}</i></span>
        <span class="fs-acc"><i class="dot"></i>小红书 / 画加 <b>@脆琉璃</b></span>
      </div>
    </div>`;
}

function renderToolbar() {
  let bar = $("#editbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "editbar";
    document.body.appendChild(bar);
  }
  if (!EDIT) { bar.innerHTML = ""; return; }
  /* 「🗑 删除此……」按钮统一放在底部按钮组的「导出 data.js」旁 */
  let delBtn = "";
  /* 角色详情页：角色操作按钮集中在工具栏（与「编辑此角色」同一套设计） */
  let charBtns = "", cardDl = "";
  if (PAGE === "character") {
    const id = new URLSearchParams(location.search).get("id");
    const i = DATA.characters.findIndex((c) => c.id === id);
    charBtns = `
      ${i >= 0 ? `<button type="button" class="ep-open" data-panel='${esc(JSON.stringify({ kind: "character", idx: i }))}'><i class="fa-solid fa-pen-to-square"></i> 编辑此角色</button>` : ""}
      <button type="button" class="ep-open" data-panel-add='${esc(JSON.stringify({ kind: "character" }))}'><i class="fa-solid fa-plus"></i> 新增角色</button>`;
    if (i >= 0) {
      cardDl = `<button type="button" class="ep-open" id="btnCardPng"><i class="fa-solid fa-image"></i> 下载角色卡 PNG</button>
      <button type="button" class="ep-open" id="btnCardTxt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button>`;
      delBtn = `<button type="button" class="ep-open tb-del" id="btnDelChar" data-char="${esc(id)}">删除</button>`;
    }
  }
  /* 关系详情页：编辑 / 新增 全部归入工具栏按钮组（与角色页一致） */
  let relBtns = "";
  if (PAGE === "relationship" && DATA.relationships.length) {
    const rid = new URLSearchParams(location.search).get("id");
    let ri = DATA.relationships.findIndex((r) => r.id === rid);
    if (ri < 0) ri = 0;
    const curRel = DATA.relationships[ri];
    relBtns = `
      <button type="button" class="ep-open" data-panel='${esc(JSON.stringify({ kind: "relationship", idx: ri }))}'><i class="fa-solid fa-pen-to-square"></i> 编辑此关系</button>
      <button type="button" class="ep-open" data-panel-add='${esc(JSON.stringify({ kind: "relationship" }))}'><i class="fa-solid fa-plus"></i> 新增关系</button>
      <button type="button" class="ep-open" id="btnRelPng"><i class="fa-solid fa-image"></i> 下载关系页 PNG</button>
      <button type="button" class="ep-open" id="btnRelTxt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button>`;
    delBtn = `<button type="button" class="ep-open tb-del" id="btnDelRel" data-rel="${esc(curRel.id)}">删除</button>`;
  }
  /* 世界观详情页（worldview.html?id=）：编辑 / 新增 归入工具栏按钮组 */
  let wvdBtns = "";
  if (PAGE === "worldview") {
    const wid = new URLSearchParams(location.search).get("id");
    if (wid) {
      const wi = DATA.worldviews.findIndex((w) => String(w.no) === String(wid));
      if (wi >= 0) {
        wvdBtns = `
          <button type="button" class="ep-open" data-panel='${esc(JSON.stringify({ kind: "worldview", idx: wi }))}'><i class="fa-solid fa-pen-to-square"></i> 编辑此世界观</button>
          <button type="button" class="ep-open" data-panel-add='${esc(JSON.stringify({ kind: "worldview" }))}'><i class="fa-solid fa-plus"></i> 新增世界观</button>
          <button type="button" class="ep-open" id="btnWvdPng"><i class="fa-solid fa-image"></i> 下载世界观 PNG</button>
          <button type="button" class="ep-open" id="btnWvdTxt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button>`;
        delBtn = `<button type="button" class="ep-open tb-del" id="btnDelWv" data-wv="${wi}">删除</button>`;
      }
    }
  }
  bar.innerHTML = `
    <div class="edit-toolbar">
      ${charBtns}
      ${cardDl}
      ${relBtns}
      ${wvdBtns}
      ${delBtn}
      ${syncPillHTML()}
      <button type="button" class="ep-open" id="btnImport"><i class="fa-solid fa-upload"></i> 导入 data.js</button>
      <button type="button" class="ep-open" id="btnExport"><i class="fa-solid fa-download"></i> 导出 data.js</button>
      <button type="button" class="ep-open" id="btnDone"><i class="fa-solid fa-check"></i> 完成</button>
    </div>`;
  paintSyncPill();
}

/* ---------- 页面大标题（杂志编辑风：数字压角 + 底部禁转条） ---------- */
/* 标题后半段自动换主题色；编辑模式下保持纯文本可直接修改 */
function heroSplit(txt) {
  const s = String(txt);
  if (s.length < 2) return esc(s);
  const cut = Math.ceil(s.length / 2);
  return `${esc(s.slice(0, cut))}<b>${esc(s.slice(cut))}</b>`;
}
function heroV2({ num, titleHTML, subPre, subHTML, tagHTML, tagSmall, extra = "" }) {
  return `
    <div class="hero-v2 fade-up">
      <span class="hv2-num" aria-hidden="true">${esc(num)}</span>
      <div class="hv2-main">
        <div class="hv2-left">
          <h1 class="hv2-title">${titleHTML}</h1>
          <div class="hv2-sub"><i>${esc(subPre)}</i>${subHTML}</div>
        </div>
        <div class="hv2-tag">${tagHTML}<small>${esc(tagSmall)}</small></div>
      </div>
      <div class="hv2-claim">
        <span class="c1"><b>✳</b>&nbsp;無断転載禁止</span>
        <span class="c2">UNAUTHORIZED REPRODUCTION PROHIBITED</span>
        <span class="c3">二次利用・自称厳禁</span>
        <span class="c4">FOR ARCHIVAL USE ONLY&nbsp;<b>✳</b></span>
      </div>
      ${extra}
    </div>`;
}

/* ---------- 小节标题（extra：编辑模式下附加的分部编辑按钮等） ---------- */
function secHead(no, cn, en, extra = "") {
  return `
    <div class="sec-head fade-up">
      <div class="no">${esc(no)}</div>
      <h2>${cn}${extra}</h2>
      <div class="en">${esc(en)}</div>
      <div class="rule"></div>
    </div>`;
}

/* ==========================================================
   首页
   ========================================================== */
function charCardHTML(ch, i) {
  return `
    <a class="char-card fade-up" href="character.html?id=${esc(ch.id)}" style="animation-delay:${i * 0.06}s">
      ${panelBtn("character", i, "编辑")}
      <div class="avatar">${avatarHTML(ch)}</div>
      <h3>${esc(ch.name)}</h3>
      <div class="en">${esc(ch.en)}</div>
      <div class="meta">
        <span class="chip mbti">${esc(ch.mbti)}</span>
        ${ch.tags.slice(0, 2).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
      </div>
      <p class="one-line">${esc(ch.oneLine)}</p>
      <div class="go">查看档案 →</div>
    </a>`;
}

function renderHome() {
  $("#characters").innerHTML = `
    ${secHead("01", `角色档案 <span class="mark">/</span> 索引`, "Character Index")}
    <div class="char-grid">
      ${DATA.characters.map((ch, i) => charCardHTML(ch, i)).join("")}
    </div>
    ${EDIT ? `<div class="ep-bar" style="margin-top:16px">${addEntityBtn("character", "新增角色")}</div>` : ""}`;

  $("#rel-preview").innerHTML = `
    ${secHead("02", `关系图谱 <span class="mark">/</span> 羁绊`, "Bonds & Relationships")}
    <div class="char-grid">
      ${DATA.relationships.map((rel, i) => {
        const [a, b] = rel.pair.map(charById);
        if (!a || !b) return "";
        return `
        <a class="char-card fade-up" href="relationship.html?id=${esc(rel.id)}">
          ${panelBtn("relationship", i, "编辑")}
          <div class="meta" style="margin-bottom:14px">
            <span class="chip mbti">${esc(hashLabel(rel.hashtag))}</span>
          </div>
          <h3>${esc(a.name)} <span style="color:var(--primary)">×</span> ${esc(b.name)}</h3>
          <div class="en">${esc(rel.en)}</div>
          <div class="meta">${rel.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
          <p class="one-line">「<span>${esc(rel.tagline)}</span>」</p>
          <div class="go">查看时间线 →</div>
        </a>`;
      }).join("")}
    </div>
    ${EDIT ? `<div class="ep-bar" style="margin-top:16px">${addEntityBtn("relationship", "新增关系")}</div>` : ""}`;

  $("#world-preview").innerHTML = `
    ${secHead("03", `世界观记录册 <span class="mark">/</span> 目录`, "Worldview Archive")}
    <div class="char-grid">
      ${DATA.worldviews.map((w, i) => `
        <a class="char-card fade-up" href="worldview.html?id=${esc(w.no)}">
          ${panelBtn("worldview", i, "编辑")}
          <div class="bg-no">${esc(w.no)}</div>
          <h3>「<span>${esc(w.title)}</span>」</h3>
          <div class="en">FILE NO.${esc(w.no)}</div>
          <div class="meta"><span class="chip">${esc(w.type)}</span></div>
          <p class="one-line">${esc(w.desc[0] || "")}</p>
          <div class="go">翻开档案 →</div>
        </a>`).join("")}
    </div>
    ${EDIT ? `<div class="ep-bar" style="margin-top:16px">${addEntityBtn("worldview", "新增世界观")}</div>` : ""}`;
}

/* ==========================================================
   角色详情页
   ========================================================== */
/* 角色索引页：不带 ?id= 访问 character.html 时展示全部角色 */
function renderCharacterIndex() {
  document.title = `角色档案 · ${DATA.site.title}`;
  $("#detail").innerHTML = `
    ${heroV2({
      num: "02",
      titleHTML: heroSplit("角色档案"),
      subPre: "IDX.",
      subHTML: "CHARACTER INDEX",
      tagHTML: `共 ${DATA.characters.length} 位`,
      tagSmall: "CAST FILE",
    })}
    <div class="char-grid" style="margin-top:26px">
      ${DATA.characters.map((ch, i) => charCardHTML(ch, i)).join("")}
    </div>
    ${DATA.characters.length ? "" : `<p style="margin-top:20px">暂无角色，请在编辑模式中「＋ 新增角色」。</p>`}
    <a class="back-link" href="index.html">← 返回档案馆</a>`;
}

/* ==========================================================
   角色详情页 · 时尚杂志双版式（由「杂志专访」概念延伸）
   ?style=street 街头潮流刊（默认） / noir 黑白大片
   ========================================================== */
function renderCharacter() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const i = DATA.characters.findIndex((c) => c.id === id);
  const ch = DATA.characters[i];
  if (!id || !ch) {
    renderCharacterIndex();
    return;
  }
  document.title = `${ch.name} · ${DATA.site.title}`;

  /* 默认版式为「街头潮流刊」，可通过页面上的版式切换栏（或 ?style= 参数）切换 */
  const styles = ["street", "noir"];
  const STYLE_NAMES = { street: "街头潮流刊", noir: "黑白大片" };
  const styleKey = styles.includes(params.get("style")) ? params.get("style") : "street";
  const keepStyle = `&style=${styleKey}`;
  const ctx = { ch, idx: i, no: String(i + 1).padStart(2, "0"), keepStyle };
  const tpl = { noir: charNoirHTML, street: charStreetHTML };

  $("#detail").innerHTML = `
    <nav class="style-switch fade-up" aria-label="版式切换">
      <label>LAYOUT&nbsp;/&nbsp;版式</label>
      ${styles.map((s) => `<a class="${s === styleKey ? "cur" : ""}" href="character.html?id=${esc(id)}&style=${s}"${s === styleKey ? ' aria-current="true"' : ""}>${STYLE_NAMES[s]}</a>`).join("")}
    </nav>
    ${tpl[styleKey](ctx)}
    <a class="back-link" href="index.html">← 返回档案馆</a>`;
}

/* 角色切换栏（两版式共用，各自定制样式） */
function charSwitchHTML(cls, label, cur, keepStyle) {
  return `
    <nav class="${cls}">
      <label>${label}</label>
      ${DATA.characters.map((c) => `
        <a class="${c.id === cur ? "cur" : ""}" href="character.html?id=${esc(c.id)}${keepStyle}">${esc(c.name)}</a>`).join("")}
    </nav>`;
}

/* ---------- 版式「黑白大片」：暗场 editorial + 白纸语录区 ---------- */
function charNoirHTML({ ch, idx, no, keepStyle }) {
  const acc = parseHex(ch.colors[0]?.hex) || "#8ab8a0";
  return `
    <div class="fmn fade-up" style="--acc:${esc(acc)}">
      <section class="fmn-stage">
        <span class="fmn-no" aria-hidden="true">№${no}</span>
        <span class="fmn-ghost" aria-hidden="true">${esc((ch.en || "").toUpperCase())}</span>
        <div class="fmn-photo">${avatarHTML(ch)}</div>
        <div class="fmn-head">
          <span class="fmn-kicker">THE CHARACTER ISSUE</span>${charPartBtn(idx, "basic", "✎ 编辑基本信息")}
          <h1>${esc(ch.name)}</h1>
          <div class="fmn-roles">
            <b>${esc(ch.mbti)}</b><i>/</i><b>${esc(ch.alignment)}</b>
          </div>
          <p class="fmn-line"><span>${esc(ch.oneLine)}</span></p>
          <div class="fmn-tags">
            ${ch.tags.map((t, ti) => `<span class="fmn-tag"><span>${esc(t)}</span></span>`).join("")}${charPartBtn(idx, "tags")}
          </div>
        </div>
        <div class="fmn-credits">
          <label>CREDITS / 基本资料${charPartBtn(idx, "profile")}</label>
          ${Object.entries(ch.profile).map(([k, v]) => `
            <div class="fmn-cr">
              <span class="k">${esc(k)}</span>
              <span class="v"><span>${esc(v)}</span></span>
            </div>`).join("")}
        </div>
      </section>

      <section class="fmn-paper">
        ${EDIT ? `<div class="cpart-bar">${charPartBtn(idx, "quotes", "✎ 编辑语录")}</div>` : ""}
        <div class="fmn-quotes">
          ${ch.quotes.map((q, qi) => Array.isArray(q.dialog) ? `
            <div class="fmn-q dlg">
              <i aria-hidden="true">0${qi + 1}</i>
              ${dialogLinesHTML(q)}
            </div>` : `
            <div class="fmn-q">
              <i aria-hidden="true">0${qi + 1}</i>
              <p><span>${esc(q.text)}</span></p>
            </div>`).join("")}
        </div>
        <div class="fmn-story">
          <label>STORY / 人物志${charPartBtn(idx, "intro")}</label>
          ${ch.intro.map((p) => `<p>${paraHTML(p)}</p>`).join("")}
          <div class="fmn-inks">
            ${ch.colors.map((c) => { const hex = parseHex(c.hex) || c.hex; return `
              <span class="fmn-ink">
                <i style="background:${esc(hex)}"></i>
                <em>${esc(hex)}</em>
              </span>`; }).join("")}${charPartBtn(idx, "colors")}
          </div>
        </div>
      </section>
      ${charSwitchHTML("fmn-next", "NEXT MODEL", ch.id, keepStyle)}
    </div>`;
}

/* 对话组的甲乙双方：甲＝组内第一个有名字的说话人，乙＝第一个不同于甲的说话人 */
function dialogParties(dialog) {
  const a = dialog.find((l) => l.who)?.who || "";
  const b = dialog.map((l) => l.who).find((w) => w && w !== a) || "";
  return { a, b };
}

/* 名签配色 → CSS 变量串（仅输出已设定的项，未设定的走上层默认） */
function whoColorVars(store) {
  if (!store) return "";
  return ["a", "b"].map((k) => {
    const c = store[k] || {};
    return `${c.bg ? `--who-${k}-bg:${esc(c.bg)};` : ""}${c.text ? `--who-${k}-fg:${esc(c.text)};` : ""}`;
  }).join("");
}

/* ---------- 语录区（街头潮流刊）：单人语录集中在「语气示例」一栏，对话独立成卡
   单人语录 {text} / 角色对话 {dialog:[{who,text},…], colors?:{a,b}} ---------- */
function voiceHTML(ch) {
  const solos = [], dialogs = [];
  ch.quotes.forEach((q) => (Array.isArray(q.dialog) ? dialogs : solos).push(q));
  const soloBlock = !solos.length ? "" : `
    <section class="fv-solos">
      <header class="fv-top">
        <b class="fv-cap">TONE&nbsp;/&nbsp;语气示例</b>
      </header>
      <div class="fv-grid">
        ${solos.map((q) => `
          <article class="fv-solo">
            <b class="fv-mark" aria-hidden="true">“</b>
            <p class="fv-text"><span>${esc(q.text)}</span></p>
            <b class="fv-mark end" aria-hidden="true">”</b>
          </article>`).join("")}
      </div>
    </section>`;
  /* 「DIALOGUE / 对话」栏题只出现一次；每组对话上方都有阿拉伯数字计数横线；
     名签配色按「人」跨角色卡继承：某人在任何一张角色卡的任一组对话里被设定过
     （q.colors），其它组、其它角色卡的同名说话人默认继承同一配色，
     组内自己的设定优先、本卡设定优先于其它卡；旁白（who 为空）居中、不带名签 */
  const personColors = globalWhoColors(ch);
  const dialogBlocks = dialogs.map((q, di) => {
    const { a, b } = dialogParties(q.dialog);
    const qc = q.colors || {};
    const eff = {};
    [["a", a], ["b", b]].forEach(([k, name]) => {
      const own = qc[k] || {}, inherited = personColors[name] || {};
      eff[k] = { bg: own.bg || inherited.bg, text: own.text || inherited.text };
    });
    const vars = whoColorVars(eff);
    return `
      ${di === 0 ? `
      <header class="fv-top fv-dlg-cap">
        <b class="fv-cap">DIALOGUE&nbsp;/&nbsp;对话</b>
      </header>` : ""}
      <section class="fv-dialog"${vars ? ` style="${vars}"` : ""}>
        <header class="fv-top">
          <b class="fv-cap num">${di + 1}</b>
        </header>
        <div class="fv-turns">
          ${q.dialog.map((l) => `
            <div class="fv-turn ${!l.who ? "n" : l.who === a ? "a" : "b"}">
              ${l.who ? `<b class="who">${esc(l.who)}</b>` : ""}
              <p><span>${esc(l.text)}</span></p>
            </div>`).join("")}
        </div>
      </section>`;
  }).join("");
  return soloBlock + dialogBlocks;
}

/* 对话在「黑白大片」里的降级渲染：一行一句「角色名：台词」；旁白不带名签 */
function dialogLinesHTML(q) {
  return q.dialog.map((l) => `
    <p class="dl${l.who ? "" : " n"}">${l.who ? `<b>${esc(l.who)}</b>` : ""}<span>${esc(l.text)}</span></p>`).join("");
}

/* 角色代词：按「性别」字段取「他 / 她 / 祂」。
   同时含男女（如「男（三成时间为女身）」）以先出现者为主；无从判别（如「？」/ 空）用「祂」 */
function pronounOf(ch) {
  const g = String((ch.profile && ch.profile["性别"]) || "");
  const mi = g.search(/[男♂]/);
  const fi = g.search(/[女♀]/);
  if (mi >= 0 && fi >= 0) return mi <= fi ? "他" : "她";
  if (mi >= 0) return "他";
  if (fi >= 0) return "她";
  return "祂";
}

/* ---------- 版式「街头潮流刊」：图形海报风（大字混排 + 几何装饰） ---------- */
function charStreetHTML({ ch, idx, no, keepStyle }) {
  const acc = parseHex(ch.colors[0]?.hex) || "#e0a63c";
  const enUp = esc((ch.en || "OC").toUpperCase());
  /* 首字实心、其余描边 */
  const nameHTML = `<b>${esc(String(ch.name).slice(0, 1))}</b><i>${esc(String(ch.name).slice(1))}</i>`;
  return `
    <div class="fms fade-up" style="--acc:${esc(acc)}">
      <section class="fms-box">
        <div class="fms-kicker">
          <span class="fk-bar">第525期&nbsp;/&nbsp;欲说还休&nbsp;/&nbsp;${esc(ch.name)}专访</span>
          <i class="fk-rule" aria-hidden="true"></i>
          <span class="fk-checker" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        </div>

        <header class="fms-head">
          <div class="fms-title">
            <span class="fms-kick2">CHARACTER&nbsp;FILE&nbsp;—&nbsp;EXCLUSIVE&nbsp;INTERVIEW</span>${charPartBtn(idx, "basic", "✎ 编辑基本信息")}
            <h1 class="fms-h1">${nameHTML}</h1>
            <div class="fms-sub">
              <span>${esc(ch.en)}</span>
              <b>${esc(ch.mbti)}</b>
            </div>
          </div>
          <div class="fms-corner" aria-hidden="true">
            <span class="fc-no">${no}</span>
            <span class="fc-txt">№525&nbsp;·&nbsp;NEW&nbsp;FILE</span>
          </div>
        </header>

        <div class="fms-grid">
          <div class="fms-left">
            <div class="fms-photo">${avatarHTML(ch)}</div>
          </div>
          <div class="fms-data">
            <div class="fms-t">DATA<span>基本资料</span>${charPartBtn(idx, "profile")}</div>
            ${Object.entries(ch.profile).map(([k, v]) => `
              <div class="fms-dr">
                <label>${esc(k)}</label>
                <b><span>${esc(v)}</span></b>
              </div>`).join("")}
          </div>
        </div>

        <div class="fms-tagblock">
          <span class="fa-cap" aria-hidden="true">ABOUT&nbsp;/&nbsp;关于${pronounOf(ch)}</span>
          <div class="fa-row">
            <i class="fa-side l" aria-hidden="true"></i>
            <span class="fms-align">${esc(ch.alignment)}</span>
            <i class="fa-side r" aria-hidden="true"></i>
          </div>
          <div class="fms-tags2">
            ${ch.tags.map((t, ti) => `<span class="fms-tag2"><span>${esc(t)}</span></span>`).join("")}${charPartBtn(idx, "tags")}
          </div>
        </div>

        <p class="fms-line"><b class="fl-tri" aria-hidden="true">▶▶▶</b><span>${esc(ch.oneLine)}</span><b class="fl-tri" aria-hidden="true">◀◀◀</b></p>

        <div class="fms-t">STORY<span>人物志</span>${charPartBtn(idx, "intro")}</div>
        <div class="fms-story">
          ${ch.intro.map((p, pi) => `<p><i aria-hidden="true">${String(pi + 1).padStart(2, "0")}</i>${paraHTML(p)}</p>`).join("")}
        </div>

        <div class="fms-t">VOICE<span>只言片语</span>${charPartBtn(idx, "quotes")}</div>
        <div class="fms-voice">
          ${voiceHTML(ch)}
        </div>

        <div class="fms-foot">
          <div class="ff-code">
            <span class="fms-code" aria-hidden="true"></span>
            <span class="ff-cap">CHARACTER&nbsp;/&nbsp;ARCHIVE&nbsp;/&nbsp;FILE&nbsp;${no}</span>
          </div>
          <span class="fms-colorset">
            ${ch.colors.map((c) => { const hex = parseHex(c.hex) || c.hex; return `
              <span class="fms-dot">
                <i style="background:${esc(hex)}"></i>
                <em>${esc(hex)}</em>
              </span>`; }).join("")}${charPartBtn(idx, "colors")}
          </span>
        </div>

        <footer class="fms-bottom" aria-hidden="true">
          <span class="fb-dots"></span>
          <span class="fb-name">${enUp}</span>
          <span class="fb-dots"></span>
        </footer>
      </section>
      ${charSwitchHTML("fms-next", "MORE DROPS", ch.id, keepStyle)}
    </div>`;
}

/* ==========================================================
   关系页
   ========================================================== */
function renderRelationship() {
  if (!DATA.relationships.length) {
    $("#rel").innerHTML = `<div class="detail-hero"><div class="tag-title">暂无关系档案</div></div>
      <p style="margin-top:20px">请回到首页，在编辑模式中「＋ 新增关系」。</p>
      <a class="back-link" href="index.html">← 返回档案馆</a>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const ri = Math.max(0, DATA.relationships.findIndex((r) => r.id === params.get("id")));
  const rel = DATA.relationships[ri];
  const [a, b] = rel.pair.map(charById);
  if (!a || !b) {
    $("#rel").innerHTML = `<div class="detail-hero"><div class="tag-title">角色缺失</div></div>
      <p style="margin-top:20px">这条关系涉及的角色已被删除。</p>
      <a class="back-link" href="index.html">← 返回档案馆</a>`;
    return;
  }
  document.title = `${hashLabel(rel.hashtag)} · ${DATA.site.title}`;

  /* 兼容旧数据：补齐「称呼」与「表里态度」字段 */
  rel.calls = rel.calls || {};
  rel.attitude = rel.attitude || {};
  rel.custom = rel.custom || [];
  /* 角色卡对话名签配色（按角色名全局继承），时间线气泡与采访间名签共用 */
  const whoColors = globalWhoColors();
  [a, b].forEach((c) => {
    if (typeof rel.calls[c.id] !== "string") rel.calls[c.id] = "—";
    if (!rel.attitude[c.id]) rel.attitude[c.id] = { surface: "—", inner: "—" };
  });
  $("#rel").innerHTML = `
    ${heroV2({
      num: "03",
      titleHTML: heroSplit(rel.title),
      subPre: "REL.",
      subHTML: `<span>${esc(rel.en)}</span>`,
      tagHTML: `<span>${esc(hashLabel(rel.hashtag))}</span>`,
      tagSmall: `FILE N°${String(ri + 1).padStart(2, "0")}`,
      extra: `<div class="selector">
        ${DATA.relationships.map((r) => `
          <button type="button" class="${r.id === rel.id ? "active" : ""}"
            onclick="location.search='?id=${esc(r.id)}'">${esc(hashLabel(r.hashtag))}</button>`).join("")}
      </div>`,
    })}
    ${EDIT ? `<div class="cpart-bar fade-up">${relPartBtn(ri, "basic", "✎ 编辑基本信息")}</div>` : ""}

    <div class="pair-head fade-up">
      <div class="pair-side">
        <div class="pair-figure">
          <div class="avatar">${avatarHTML(a)}</div>
          <h3>${esc(a.name)}</h3>
        </div>
      </div>
      <div class="pair-mid">
        <div class="att-group to-a">
          <svg class="att-curve" viewBox="0 0 300 26" preserveAspectRatio="none" aria-hidden="true">
            <defs><marker id="ah-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
            <path d="M296 24 Q150 -16 4 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" marker-end="url(#ah-a)"/>
          </svg>
          <span class="att-line face"><span>${esc(rel.attitude[b.id].surface)}</span></span>
          <span class="att-line heart"><span>${esc(rel.attitude[b.id].inner)}</span></span>
          <span class="att-dash to-a" aria-hidden="true"></span>
        </div>
        <div class="pair-calls">
          <div class="bubble a"><span>${esc(rel.calls[a.id])}</span></div>
          <div class="bubble b"><span>${esc(rel.calls[b.id])}</span></div>
        </div>
        <div class="att-group to-b">
          <span class="att-dash to-b" aria-hidden="true"></span>
          <span class="att-line heart"><span>${esc(rel.attitude[a.id].inner)}</span></span>
          <span class="att-line face"><span>${esc(rel.attitude[a.id].surface)}</span></span>
          <svg class="att-curve" viewBox="0 0 300 26" preserveAspectRatio="none" aria-hidden="true">
            <defs><marker id="ah-b" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
            <path d="M4 2 Q150 42 296 2" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" marker-end="url(#ah-b)"/>
          </svg>
        </div>
      </div>
      <div class="pair-side">
        <div class="pair-figure">
          <div class="avatar">${avatarHTML(b)}</div>
          <h3>${esc(b.name)}</h3>
        </div>
      </div>
    </div>

    <div style="text-align:center;margin-top:20px" class="fade-up">
      <span class="ribbon"><span>${esc(rel.tagline)}</span></span>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        ${rel.tags.map((t, ti) => `<span class="pill"><span>${esc(t)}</span></span>`).join("")}
      </div>
    </div>

    ${secHead("R-01", `遇到彼此 <span class="mark">之前</span>`, "Before We Met", relPartBtn(ri, "before"))}
    ${(() => {
      /* 标题中的角色名按角色配色变色：默认取角色卡主代表色，
         可在「遇到彼此之前」编辑框切换为语录对话名签色或自定义颜色 */
      const mode = rel.beforeNameColor;
      const voiceMap = mode === "voice" ? globalWhoColors() : null;
      const customMap = rel.beforeNameCustom || {};
      const nameColor = (ch) => {
        if (mode === "custom") {
          const v = parseHex(customMap[ch.id]);
          if (v) return v;
        }
        if (voiceMap) {
          const v = parseHex((voiceMap[ch.name] || {}).bg);
          if (v) return v;
        }
        return parseHex(ch.colors && ch.colors[0] && ch.colors[0].hex) || "";
      };
      const nm = (ch) => {
        const c = nameColor(ch);
        return `<b${c ? ` style="color:${esc(c)}"` : ""}>${esc(ch.name)}</b>`;
      };
      return `
    <div class="before-grid fade-up">
      <div class="panel before-card">
        <div class="bc-title">遇到${nm(b)}之前的${nm(a)}</div>
        <p>${esc(rel.before[a.id] || "")}</p>
      </div>
      <div class="panel before-card">
        <div class="bc-title">遇到${nm(a)}之前的${nm(b)}</div>
        <p>${esc(rel.before[b.id] || "")}</p>
      </div>
    </div>`;
    })()}

    ${secHead("R-02", `Timeline <span class="mark">/</span> 时间线`, "How We Got Here", relPartBtn(ri, "timeline"))}
    <div class="timeline fade-up">
      ${rel.timeline.map((t, ti) => `
        <div class="tl-item">
          <div class="tl-era">— <span>${esc(t.era)}</span></div>${EDIT ? `<button type="button" class="wve-edit tl-edit" data-rel-stage='${esc(JSON.stringify({ idx: ri, ti }))}'>✎ 编辑</button><button type="button" class="wve-del tl-edit" data-rel-stage-del='${esc(JSON.stringify({ idx: ri, ti }))}'>✕ 删除</button>` : ""}
          <div class="tl-card">
            <span>${esc(t.text)}</span>
            <div class="tl-bubbles">
              ${t.bubbles.map((bb, bi) => {
                /* 纯气泡（无角色名签）：颜色即身份——本关系「对话气泡配色」自设优先，
                   未设时继承说话人在角色卡对话里的名签配色，再回退默认气泡色 */
                const side = bb.side === "b" ? "b" : "a";
                const own = (rel.tlColors || {})[side] || {};
                const inh = whoColors[bb.who] || {};
                const bg = parseHex(own.bg) || parseHex(inh.bg);
                const fg = parseHex(own.text) || parseHex(inh.text);
                const st = `${bg ? `background:${bg};` : ""}${fg ? `color:${fg};` : ""}`;
                return `
                <div class="bubble ${side}"${st ? ` style="${st}"` : ""}><span>${esc(bb.text)}</span></div>`;
              }).join("")}
            </div>
          </div>
        </div>`).join("")}
    </div>
    ${EDIT ? `<button type="button" class="part-add" id="relAddStage" data-rel-idx="${ri}" style="margin-top:14px"><b>＋ 新增时间线阶段 <i>XINZENG JIEDUAN</i></b><span>在时间线末尾插入一个阶段，并打开它的小编辑框</span></button>` : ""}

    ${secHead("R-03", `Interview <span class="mark">/</span> 采访间`, "Q & A", relPartBtn(ri, "interview"))}
    <div class="panel fade-up qa-grid">
      ${(() => {
        /* 回答者名签配色：本关系「回答者名签配色」自设优先，
           未设时继承该角色在角色卡对话里的名签色 */
        const qaC = rel.qaColors || {};
        const whoStyle = (name) => {
          const side = name === a.name ? "a" : name === b.name ? "b" : null;
          const own = (side && qaC[side]) || {};
          const inh = whoColors[name] || {};
          const bg = parseHex(own.bg) || parseHex(inh.bg);
          const fg = parseHex(own.text) || parseHex(inh.text);
          const s = `${bg ? `background:${bg};` : ""}${fg ? `color:${fg};` : ""}`;
          return s ? ` style="${s}"` : "";
        };
        return rel.interview.map((qa, qi) => `
        <div class="qa-block">
          <div class="qa-q">${esc(qa.q)}</div>${EDIT ? `<button type="button" class="wve-edit" data-rel-qa='${esc(JSON.stringify({ idx: ri, qi }))}'>✎ 编辑</button><button type="button" class="wve-del" data-rel-qa-del='${esc(JSON.stringify({ idx: ri, qi }))}'>✕ 删除</button>` : ""}
          ${qa.answers.map((ans, ai) => `
            <div class="qa-row">
              <span class="qa-who"${whoStyle(ans.who)}>${esc(ans.who)}</span>
              <span class="qa-text">${esc(ans.text)}</span>
            </div>`).join("")}
        </div>`).join("");
      })()}
    </div>
    ${EDIT ? `<button type="button" class="part-add" id="relAddQa" data-rel-idx="${ri}" style="margin-top:14px"><b>＋ 新增采访问题 <i>XINZENG WENTI</i></b><span>在采访间末尾插入一个问题，并打开它的小编辑框</span></button>` : ""}

    ${rel.custom.map((m, mi) => {
      /* 自定义模块 · 登机牌票根模板：小节标题 + 左主区 + 右侧主色存根
         （撕裂虚线 + 打孔 + FLIGHT / PASS / GATE 基础信息） */
      const no = `R-${String(mi + 4).padStart(2, "0")}`;
      const en = String(m.en || "EXTRA").toUpperCase();
      const enTitle = en.toLowerCase().replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
      /* GATE 代表字：中间的 ↔ 固定，左右两字可在模块编辑框分别自定义，
         留空自动取双方名字首字。旧数据的整串 gate（含 ↔）拆两段兼容。 */
      const [gdl, gdr] = String(m.gate || "").split("↔").map((s) => s.trim());
      const gate = `${m.gateL || gdl || String(a.name).slice(0, 1)} ↔ ${m.gateR || gdr || String(b.name).slice(0, 1)}`;
      const relEn = (rel.en || "BOND").toUpperCase().replace(/[^A-Z0-9]/g, "") || "BOND";
      return `
      ${secHead(no, `${esc(enTitle)} <span class="mark">/</span> <span>${esc(m.title)}</span>`, "EXTRA MODULE",
        EDIT ? `<button type="button" class="wve-edit" data-rel-module='${esc(JSON.stringify({ idx: ri, mi }))}'>✎ 编辑</button><button type="button" class="wve-del" data-rel-module-del='${esc(JSON.stringify({ idx: ri, mi }))}'>✕ 删除</button>` : "")}
      <div class="rmod fade-up">
        <div class="rmod-main">
          <div class="rmod-cap"><span>BOND&nbsp;PASS&nbsp;/&nbsp;附加条目</span><b>${esc(relEn)}</b></div>
          <h3>${esc(m.title)}</h3>
          <div class="rmod-paras">
            ${m.text.map((p) => `<p><span>${esc(p)}</span></p>`).join("")}
          </div>
        </div>
        <div class="rmod-stub">
          <span class="rmod-punch t"></span><span class="rmod-punch b"></span>
          <span class="rmod-lab">STUB&nbsp;/&nbsp;存根</span>
          <div class="rmod-info">
            <div class="rmod-row"><label><span class="cn">航班</span><span class="en">FLIGHT</span></label><b>${esc(no)}</b></div>
            <div class="rmod-row"><label><span class="cn">座位</span><span class="en">SEAT</span></label><b>${mi + 1}A</b></div>
            <div class="rmod-row wide"><label><span class="cn">凭证</span><span class="en">PASS</span></label><b>${esc(hashLabel(rel.hashtag) || relEn)}</b></div>
          </div>
          ${(() => {
            /* 确定性伪随机：伪码方块图案与票号都随模块标题 / 英文副标题变化 */
            let h = 7;
            const seed = m.title + "::" + en;
            for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
            let cells = "";
            for (let i = 0; i < 25; i++) {
              h = (h * 1103515245 + 12345) >>> 0;
              const corner = i === 0 || i === 4 || i === 20 || i === 24;
              cells += `<i${corner || ((h >> 16) & 1) ? ' class="on"' : ""}></i>`;
            }
            const tkt = String(100000 + (h % 900000));
            return `
          <div class="rmod-deco">
            <span class="rmod-qr">${cells}</span>
            <span class="rmod-en">${esc(en)}</span>
          </div>
          <div class="rmod-code"></div>
          <div class="rmod-tkt"><span class="cn">票号</span><span class="num">TKT&nbsp;${tkt}</span></div>`;
          })()}
          <div class="rmod-gate"><span class="glab"><span class="cn">登机口</span><span class="en">GATE</span></span><span class="gval">${esc(gate)}</span><i>✈</i></div>
        </div>
      </div>`;
    }).join("")}
    ${EDIT ? `<button type="button" class="part-add" id="relAddModule" data-rel-idx="${ri}"><b>＋ 新增自定义模块 <i>XINZENG MOKUAI</i></b><span>在页面末尾插入一个「标题 + 段落」模块，并打开它的小编辑框</span></button>` : ""}

    <a class="back-link" href="index.html">← 返回档案馆</a>`;
}

/* ==========================================================
   世界观页
   ========================================================== */
function renderWorldview() {
  /* ?id=编号 → 进入世界观详情页；否则展示记录册目录 */
  const wid = new URLSearchParams(location.search).get("id");
  if (wid) {
    const wi = DATA.worldviews.findIndex((w) => String(w.no) === String(wid));
    if (wi >= 0) { renderWorldviewDetail(DATA.worldviews[wi], wi); return; }
  }
  document.title = `世界观记录册 · ${DATA.site.title}`;
  $("#world").innerHTML = `
    ${heroV2({
      num: "04",
      titleHTML: heroSplit("世界观记录册"),
      subPre: "ARC.",
      subHTML: "WORLDVIEW ARCHIVE",
      tagHTML: `共 ${DATA.worldviews.length} 册`,
      tagSmall: "FILE N°04",
    })}

    <div style="margin-top:12px">
      ${DATA.worldviews.map((w, wi) => {
        const isMain = wi === 0;
        /* 出场角色标签：留空 role 时自动读取角色卡中的「称号」（ch.mbti），否则用自定义值 */
        const castHTML = (w.cast || []).map((c) => {
          const ch = charById(c.id);
          if (!ch) return "";
          const roleText = c.role && String(c.role).trim() ? c.role : (ch.mbti || "");
          return `
              <a class="cast-item" href="character.html?id=${esc(ch.id)}" title="查看${esc(ch.name)}的档案">
                <div class="avatar">${avatarHTML(ch)}</div>
                <div>
                  <div class="cast-name">${esc(ch.name)}</div>
                  <div class="cast-role">${esc(roleText)}</div>
                </div>
              </a>`;
        }).join("");
        const subtitle = w.subtitle || "世界观背景与设定简述";
        const brief = w.brief || w.lead || (w.desc && w.desc[0]) || "";
        const editBar = EDIT ? `<div class="ep-bar"><button type="button" class="ep-open" data-wvcard="${wi}"><i class="fa-solid fa-pen-to-square"></i> 编辑此册</button></div>` : "";
        if (isMain) {
          return `
        <div class="panel wv-main fade-up" id="w-${esc(w.no)}" style="margin-top:20px">
          <span class="wv-corner c-tl"></span><span class="wv-corner c-tr"></span><span class="wv-corner c-bl"></span><span class="wv-corner c-br"></span>
          ${editBar}
          <div class="wv-top"><span>世界观记录</span><span class="wv-if">如果……</span></div>
          <h3 class="wv-title"><span class="q">「</span><span>${esc(w.title)}</span><span class="q">」</span></h3>
          <div class="wv-copy">${esc(subtitle)}</div>
          ${brief ? `<p class="wv-brief">${esc(brief)}</p>` : ""}
          <div class="world-cast">
            ${castHTML}
            <a class="rel wv-enter" href="worldview.html?id=${esc(w.no)}">◆ <span>进入${esc(w.title)}</span> →</a>
          </div>
        </div>`;
        }
        return `
        <div class="panel world-card fade-up" id="w-${esc(w.no)}" style="margin-top:20px">
          ${editBar}
          <div class="w-bg-no">${esc(w.no)}</div>
          <h3><span class="q">「</span><span>${esc(w.title)}</span><span class="q">」</span></h3>
          <div class="w-no">${esc(w.no)}</div>
          <div><span class="w-type">${esc(subtitle)}</span></div>
          ${brief ? `<p class="wv-brief">${esc(brief)}</p>` : ""}
          <div class="world-cast">
            ${castHTML}
            <a class="rel wv-enter" href="worldview.html?id=${esc(w.no)}">◆ <span>进入${esc(w.title)}</span> →</a>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${EDIT ? `<div class="ep-bar" style="margin-top:16px">${addEntityBtn("worldview", "新增世界观")}</div>` : ""}

    <a class="back-link" href="index.html">← 返回档案馆</a>`;
}

/* ==========================================================
   世界观详情页 · 钴蓝特刊（海报编辑风）
   大标题（世界观名）+ 模板板块（标题 + 内容），板块可自定义增删。
   主色取自该册 accent（默认钴蓝），注入 --wv-acc。
   ========================================================== */
function renderWorldviewDetail(w, wi) {
  document.title = `${w.title} · 世界观详情 · ${DATA.site.title}`;
  const acc = parseHex(w.accent) || "#1C34C4";
  const ed = EDIT;
  const en = (w.en || "WORLDVIEW").toUpperCase();
  const lead = w.lead || (w.desc && w.desc[0]) || "";
  const title = String(w.title || "");
  /* 大标题：前半实心主色、后半描边空心 */
  const cut = Math.ceil(title.length / 2);
  const titleHTML = `<span class="b1">${esc(title.slice(0, cut))}</span><span class="o">${esc(title.slice(cut))}</span>`;

  const sections = w.sections = Array.isArray(w.sections) ? w.sections : [];
  const idxNames = sections.map((s) => s.title);

  /* 模块 · 标题保留横铺巨标海报式 + 蓝图 SEC.XX 方框编号组件；
     词条为蓝图制图表格（弱点并入表格，⚠ 标记），配色跟随 --wv-acc 绿 */
  const secHTML = sections.map((s, si) => {
    const all = (s.entries || []).filter((e) => e && (e.k || e.v));
    const tableHTML = all.length ? `<div class="ents">${all.map((e, ei) => `
          <div class="e${e.warn ? " warn" : ""}"><span class="k"><b>${String(ei + 1).padStart(2, "0")}</b><i>/</i>${esc(e.k)}${e.warn ? '<u>⚠</u>' : ""}</span><div class="v">${esc(e.v)}</div></div>`).join("")}</div>` : "";
    const py = esc((s.en || "").toUpperCase());
    return `
      <section class="wvm" id="wvd-${esc(w.no)}-${si}">
        <div class="kick"><i></i>SHIJIEGUAN · DANGAN<span class="dots"></span>${ed ? `<button type="button" class="wve-edit" data-wve-sec-edit="${si}">✎ 编辑此板块</button><button type="button" class="wve-del sec" data-wve-del-sec="${si}" title="删除此板块">✕ 删除板块</button>` : ""}<span class="plus">＋</span></div>
        <h2>${esc(s.title)}<span class="en">${py}</span></h2>
        ${s.intro ? `<p class="intro">${esc(s.intro)}</p>` : ""}
        ${tableHTML}
      </section>`;
  }).join("");

  $("#world").innerHTML = `
    <div class="wvd fade-up" style="--wv-acc:${esc(acc)}">
      <header class="wvd-hero">
        <span class="wvd-deco wvd-circle" aria-hidden="true"></span>
        <span class="wvd-vcaps" aria-hidden="true">SHIJIEGUAN DANGAN · N°${esc(w.no)}</span>
        <div class="wvd-top">
          <span class="wvd-tag">世界观档案 <b>/</b> SHIJIEGUAN</span>
          <span class="wvd-rule"></span>
          <span class="wvd-check"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
        </div>
        <div class="wvd-main">
          <div>
            <div class="wvd-kick">SHIJIEGUAN&nbsp;—&nbsp;${esc(w.type || "")}${ed ? `&nbsp;<button type="button" class="wve-edit" id="wvdEditBasic">✎ 编辑基本信息</button>` : ""}</div>
            <h1 class="wvd-title">${titleHTML}</h1>
          </div>
          <div class="wvd-num anton">${esc(w.no)}<small>DANGAN&nbsp;N°${esc(w.no)}</small></div>
        </div>
        <div class="wvd-en"><b class="anton">${esc(en)}</b></div>
        ${lead ? `<div class="wvd-lead"><div class="ph">INTRODUCTION<span class="mk">· · ·</span></div><p>${esc(lead).replace("因果律", "<em>因果律</em>")}</p></div>` : ""}
      </header>

      <div class="wvd-index" id="wvdIndex">
        <label>MULU <span class="ar">▸</span></label>
        <div class="chips">
          ${idxNames.map((x, i) => `<a class="wvd-chip" href="#wvd-${esc(w.no)}-${i}"><b>${String(i + 1).padStart(2, "0")}</b>${esc(x)}</a>`).join("")}
        </div>
        <button type="button" class="wvd-chip wvd-more" id="wvdMore" aria-label="展开目录"><span class="ar">▾</span>展开</button>
      </div>

      <main class="wvd-body">
        ${secHTML}
        ${EDIT
      ? `<button type="button" class="wvd-add" id="wvdAddSec"><b>＋ 新增模板板块 <i>XINZENG MOKUAI</i></b><span>在页面末尾插入一个「标题 + 词条」板块，并打开它的小编辑框</span></button>`
      : ""}

        <div class="wvd-foot">
          <span class="wvd-fc">SHIJIEGUAN / DANGAN / ${esc(w.no)}</span>
          <span class="wvd-fn anton">${esc(en.split(",")[0])}</span>
        </div>
      </main>

      <a class="back-link" href="worldview.html">← 返回世界观目录</a>
    </div>`;

  /* 目录单行溢出检测：溢出时显示「···」展开按钮，点击换行展开 / 收起 */
  const idxEl = $("#wvdIndex");
  const moreBtn = $("#wvdMore");
  if (idxEl && moreBtn) {
    const chips = idxEl.querySelector(".chips");
    const CHIP_W = 118; /* 与 .wvd-chip 定宽一致 */
    const syncMore = () => {
      chips.style.maxWidth = "";
      if (idxEl.classList.contains("open")) { moreBtn.style.display = ""; return; }
      const fit = Math.max(1, Math.floor(chips.clientWidth / CHIP_W));
      if (fit < chips.children.length) {
        chips.style.maxWidth = fit * CHIP_W + "px"; /* 只显示完整放得下的项，不切半 */
        moreBtn.style.display = "";
      } else {
        moreBtn.style.display = "none";
      }
    };
    moreBtn.addEventListener("click", () => {
      idxEl.classList.toggle("open");
      moreBtn.innerHTML = idxEl.classList.contains("open") ? '<span class="ar">▴</span>收起' : '<span class="ar">▾</span>展开';
      syncMore();
    });
    /* 目录项定宽：文本过长时自动缩小字号直至放下 */
    chips.querySelectorAll(".wvd-chip").forEach((c) => {
      let fs = 13;
      while (c.scrollWidth > c.clientWidth + 1 && fs > 9) { fs -= 0.5; c.style.fontSize = fs + "px"; }
    });
    syncMore();
  }

  if (ed) bindWvdPartEdit(w, wi);
}

/* ==========================================================
   世界观详情页 · 分部编辑
   编辑模式下不打开全量编辑框：每个部分（基本信息 / 单个板块）
   都有自己的小编辑框，只包含该部分的字段。
   ========================================================== */
/* 通用局部小编辑框：只渲染传入的 schema 字段，保存时回写并整页刷新 */
function openPartPanel({ title, work, schema, onSave }) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ep-overlay";
  wrap.innerHTML = `
    <div class="ae-panel ep-panel ep-part">
      <div class="ep-head">
        <div class="ep-title"><i class="fa-solid fa-pen-to-square"></i> <span></span></div>
        <button type="button" class="ep-x" title="关闭">✕</button>
      </div>
      <div class="ep-body"></div>
      <div class="ep-foot">
        <span></span>
        <div class="ep-foot-r">
          <button type="button" class="ep-cancel">取消</button>
          <button type="button" class="ep-save">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector(".ep-title span").textContent = title;
  const body = wrap.querySelector(".ep-body");
  const rebuild = () => {
    body.innerHTML = "";
    schema.forEach((f) => body.appendChild(renderField(f, work, rebuild)));
  };
  rebuild();
  const close = () => wrap.remove();
  wrap.querySelector(".ep-x").addEventListener("click", close);
  wrap.querySelector(".ep-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector(".ep-save").addEventListener("click", () => {
    onSave(work);
    try {
      saveData();
    } catch (err) {
      /* 超出浏览器存储配额（多为头像原图过大）：回滚到保存前的数据 */
      DATA = loadData();
      renderAll();
      uiNotice("内容过大，浏览器存储空间不足。这次修改未能保存，请换小一点的图片。");
      return;
    }
    close();
    renderAll();
  });
}

/* ---------- 通用分部编辑：从实体完整 schema 中挑出某一部分的字段 ----------
   工作副本仍是整个实体，保存时整体写回（normalize 规则不变），
   小编辑框里只显示这一部分的字段。keys 匹配字段的 key 或 type。 */
function openEntityPart(kind, idx, title, keys) {
  const conf = ENTITY_PANELS[kind];
  const src = conf.get(idx);
  if (!src) return;
  const work = JSON.parse(JSON.stringify(src));
  if (conf.normalize) conf.normalize(work);
  const schema = conf.schema(work).filter((f) => (f.key && keys.includes(f.key)) || keys.includes(f.type));
  openPartPanel({
    title,
    work,
    schema,
    onSave: (v) => {
      if (conf.normalize) conf.normalize(v);
      conf.set(idx, v);
    },
  });
}

/* 角色卡的分部划分 */
const CHAR_PART_DEFS = {
  basic: { title: "基本信息", keys: ["avatar", "name", "en", "mbti", "alignment", "oneLine"] },
  tags: { title: "标签", keys: ["tags"] },
  profile: { title: "基本资料", keys: ["profile"] },
  colors: { title: "代表色", keys: ["colors"] },
  intro: { title: "人物志", keys: ["intro"] },
  quotes: { title: "语录", keys: ["quotes"] },
};
function openCharPart(idx, part) {
  const def = CHAR_PART_DEFS[part];
  const ch = DATA.characters[idx];
  if (!def || !ch) return;
  openEntityPart("character", idx, `编辑${def.title} · ${ch.name || ""}`, def.keys);
}
/* 角色卡分部编辑按钮（编辑模式显示） */
function charPartBtn(idx, part, label = "✎ 编辑") {
  if (!EDIT) return "";
  return `<button type="button" class="wve-edit" data-char-part='${esc(JSON.stringify({ idx, part }))}'>${esc(label)}</button>`;
}

/* 关系页的分部划分：基本信息包含关系标签与双方资料（称呼 / 表里态度）；
   「遇到彼此之前」独立成块 */
const REL_PART_DEFS = {
  basic: { title: "基本信息", keys: ["title", "hashtag", "en", "tagline", "pair", "tags", "relPerChar"] },
  before: { title: "遇到彼此之前", keys: ["beforeNameColor", "relBeforeCustom", "relBefore"] },
  timeline: { title: "时间线", keys: ["timeline", "tlColors"] },
  interview: { title: "访谈", keys: ["qaColors", "interview"] },
};
function openRelPart(idx, part) {
  const def = REL_PART_DEFS[part];
  const rel = DATA.relationships[idx];
  if (!def || !rel) return;
  openEntityPart("relationship", idx, `编辑${def.title} · ${hashLabel(rel.hashtag) || rel.title || ""}`, def.keys);
}
function relPartBtn(idx, part, label = "✎ 编辑") {
  if (!EDIT) return "";
  return `<button type="button" class="wve-edit" data-rel-part='${esc(JSON.stringify({ idx, part }))}'>${esc(label)}</button>`;
}

/* 单个时间线阶段的小编辑框（关系页）：只编辑这一个阶段；
   气泡配色为全时间线共用的一份，在此修改会同步到所有阶段 */
function openRelStagePanel(ri, ti) {
  const rel = DATA.relationships[ri];
  const t = rel && rel.timeline && rel.timeline[ti];
  if (!t) return;
  const pairNames = () => (rel.pair || []).map(charById).filter(Boolean).map((c) => c.name);
  const sideLabels = () => {
    const [pa, pb] = (rel.pair || []).map(charById);
    return { a: pa ? pa.name : "左侧（甲）", b: pb ? pb.name : "右侧（乙）" };
  };
  const work = JSON.parse(JSON.stringify(t));
  work.tlColors = JSON.parse(JSON.stringify(rel.tlColors || {}));
  openPartPanel({
    title: `编辑阶段 · ${t.era || ""}`,
    work,
    schema: [
      { type: "text", key: "era", label: "阶段" },
      { type: "textarea", key: "text", label: "描述" },
      { type: "objlist", key: "bubbles", label: "对话气泡", itemNoun: "气泡", addLabel: "气泡", hideCount: true,
        newItem: () => ({ side: "a", who: pairNames()[0] || "", text: "" }),
        item: [
          { type: "select", key: "side", label: "位置", options: () => [{ value: "a", label: "左" }, { value: "b", label: "右" }] },
          { type: "whoName", key: "who", label: "说话人", options: pairNames, placeholder: "选择角色" },
          { type: "textarea", key: "text", label: "台词" },
        ] },
      { type: "tlColors", key: "tlColors", label: "对话气泡配色", sideLabels },
    ],
    onSave: (v) => {
      /* 气泡配色写回全时间线共用的一份，其余字段写回本阶段 */
      rel.tlColors = v.tlColors || {};
      delete v.tlColors;
      rel.timeline[ti] = v;
    },
  });
}

/* 单个采访问题的小编辑框（关系页） */
function openRelQaPanel(ri, qi) {
  const rel = DATA.relationships[ri];
  const qa = rel && rel.interview && rel.interview[qi];
  if (!qa) return;
  const pairNames = () => (rel.pair || []).map(charById).filter(Boolean).map((c) => c.name);
  const work = JSON.parse(JSON.stringify(qa));
  openPartPanel({
    title: `编辑问题 · ${qa.q || ""}`,
    work,
    schema: [
      { type: "text", key: "q", label: "问题" },
      { type: "objlist", key: "answers", label: "回答", itemNoun: "回答", addLabel: "回答",
        newItem: () => ({ who: pairNames()[0] || "", text: "" }),
        item: [
          { type: "whoName", key: "who", label: "回答者", options: pairNames, placeholder: "选择角色" },
          { type: "textarea", key: "text", label: "回答" },
        ] },
    ],
    onSave: (v) => { rel.interview[qi] = v; },
  });
}

/* 单个自定义模块的小编辑框（关系页） */
function openRelModulePanel(ri, mi) {
  const rel = DATA.relationships[ri];
  const m = rel && rel.custom && rel.custom[mi];
  if (!m) return;
  const work = JSON.parse(JSON.stringify(m));
  /* 旧版 gate 为整串文本（含 ↔）：拆入左右两字后弃用旧字段 */
  if (work.gate) {
    const [l, r] = String(work.gate).split("↔").map((s) => s.trim());
    work.gateL = work.gateL || l || "";
    work.gateR = work.gateR || r || "";
    delete work.gate;
  }
  openPartPanel({
    title: `编辑模块 · ${m.title || ""}`,
    work,
    schema: [
      { type: "text", key: "title", label: "模块标题" },
      { type: "text", key: "en", label: "英文副标题" },
      { type: "text", key: "gateL", label: "GATE 左字", placeholder: "留空＝取角色甲名字首字", help: "票根代表字：左字 ↔ 右字，中间的 ↔ 固定不变" },
      { type: "text", key: "gateR", label: "GATE 右字", placeholder: "留空＝取角色乙名字首字" },
      { type: "stringList", key: "text", label: "段落", addLabel: "段落", textarea: true },
    ],
    onSave: (v) => { rel.custom[mi] = v; },
  });
}

/* 基本信息（编号 / 标题 / 英文副标题 / 类型 / 主色 / 导语）的小编辑框 */
function openWvBasicPanel(w) {
  const work = JSON.parse(JSON.stringify({
    no: w.no || "", title: w.title || "", en: w.en || "",
    type: w.type || "", accent: w.accent || "", lead: w.lead || "",
  }));
  openPartPanel({
    title: `编辑基本信息 · ${w.title || ""}`,
    work,
    schema: [
      { type: "text", key: "no", label: "编号" },
      { type: "text", key: "title", label: "标题" },
      { type: "text", key: "en", label: "英文副标题" },
      { type: "text", key: "type", label: "类型" },
      { type: "text", key: "accent", label: "详情页主色" },
      { type: "textarea", key: "lead", label: "一句话导语" },
    ],
    onSave: (v) => {
      /* 主色色号可省略 #，保存时自动补全 */
      const p = parseHex(v.accent);
      if (p) v.accent = p;
      Object.assign(w, v);
    },
  });
}

/* 单个板块（标题 / 英文副标题 / 引言 / 词条）的小编辑框 */
function openWvSectionPanel(w, si) {
  const s = w.sections[si];
  if (!s) return;
  const work = JSON.parse(JSON.stringify(s));
  openPartPanel({
    title: `编辑板块 · ${s.title || ""}`,
    work,
    schema: [
      { type: "text", key: "title", label: "板块标题" },
      { type: "text", key: "en", label: "英文副标题" },
      { type: "textarea", key: "intro", label: "引言段" },
      { type: "objlist", key: "entries", label: "词条", itemNoun: "词条", addLabel: "词条",
        newItem: () => ({ k: "", v: "" }),
        item: [
          { type: "text", key: "k", label: "词条名" },
          { type: "textarea", key: "v", label: "内容" },
        ] },
    ],
    onSave: (v) => { w.sections[si] = v; },
  });
}

/* 世界观记录册卡片 · 受限编辑框
   只包含 标题 / 副标题 / 简介 / 出场角色 四项；
   出场角色的标签留空时自动读取角色卡中的「称号」，也可自由填写。 */
function openWvCardPanel(w, wi) {
  const work = {
    title: w.title || "",
    subtitle: w.subtitle || "",
    brief: w.brief || w.lead || (w.desc && w.desc[0]) || "",
    cast: JSON.parse(JSON.stringify(w.cast || [])),
  };
  openPartPanel({
    title: `编辑此册 · ${w.title || ""}`,
    work,
    schema: [
      { type: "text", key: "title", label: "标题" },
      { type: "text", key: "subtitle", label: "副标题" },
      { type: "textarea", key: "brief", label: "简介", rows: 3 },
      { type: "objlist", key: "cast", label: "出场角色", itemNoun: "角色", addLabel: "角色",
        newItem: () => ({ id: DATA.characters[0]?.id || "", role: "" }),
        item: [
          { type: "select", key: "id", label: "角色", options: () => DATA.characters.map((c) => ({ value: c.id, label: c.name })) },
          { type: "text", key: "role", label: "标签", placeholder: "留空＝自动读取角色称号",
            help: "留空自动读取该角色卡中的称号，也可自由填写" },
        ] },
    ],
    onSave: (v) => {
      w.title = v.title;
      w.subtitle = v.subtitle;
      w.brief = v.brief;
      /* 标签留空则不落库，展示时自动读取称号 */
      w.cast = (v.cast || []).map((c) => {
        const o = { id: c.id };
        if (c.role && String(c.role).trim()) o.role = String(c.role).trim();
        return o;
      });
    },
  });
}

function bindWvdPartEdit(w, wi) {
  const root = $("#world");
  if (!root) return;
  const rerender = () => { saveData(); renderWorldviewDetail(w, wi); };

  /* ✎ 编辑基本信息 */
  const basicBtn = $("#wvdEditBasic");
  if (basicBtn) basicBtn.addEventListener("click", () => openWvBasicPanel(w));

  /* ✎ 编辑此板块：小编辑框只含该板块字段 */
  root.querySelectorAll("[data-wve-sec-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openWvSectionPanel(w, +btn.dataset.wveSecEdit));
  });
  /* ✕ 删除板块 */
  root.querySelectorAll("[data-wve-del-sec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const si = +btn.dataset.wveDelSec;
      if (!w.sections[si]) return;
      uiConfirm(`确定删除板块「${w.sections[si].title || ""}」？`, () => { w.sections.splice(si, 1); rerender(); });
    });
  });
  /* ＋ 新增模板板块：插入页面底部并立即打开它的小编辑框 */
  const addSec = $("#wvdAddSec");
  if (addSec) addSec.addEventListener("click", () => {
    w.sections.push({ title: "", en: "", intro: "", entries: [{ k: "", v: "" }] });
    rerender();
    const secs = $("#world").querySelectorAll(".wvm");
    if (secs.length) secs[secs.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
    openWvSectionPanel(w, w.sections.length - 1);
  });
}

/* ==========================================================
   编辑模式：新增模板
   ========================================================== */
function newCharacter() {
  /* 新建即留空：编辑框内不预填任何示例文本，由创建者自行填写 */
  return {
    id: "char-" + Date.now().toString(36),
    name: "", en: "", avatar: "",
    mbti: "", alignment: "",
    tags: [],
    oneLine: "",
    profile: { "性别": "", "生日": "", "身高": "", "身份": "", "武器": "", "喜欢": "", "讨厌": "" },
    colors: [{ hex: "#75B596" }, { hex: "#438855" }],
    intro: [""],
    quotes: [{ text: "" }],
  };
}

function newRelationship() {
  if (DATA.characters.length < 2) { uiNotice("至少需要两名角色才能创建关系档案。"); return null; }
  const [a, b] = DATA.characters;
  return {
    id: "rel-" + Date.now().toString(36),
    title: "", hashtag: "", en: "",
    pair: [a.id, b.id],
    tags: [], tagline: "",
    before: { [a.id]: "", [b.id]: "" },
    calls: { [a.id]: "", [b.id]: "" },
    attitude: {
      [a.id]: { surface: "", inner: "" },
      [b.id]: { surface: "", inner: "" },
    },
    timeline: [{ era: "", text: "", bubbles: [] }],
    interview: [{ q: "", answers: [{ who: a.name, text: "" }, { who: b.name, text: "" }] }],
    custom: [],
  };
}

function newWorldview() {
  const no = String(DATA.worldviews.length + 1).padStart(2, "0");
  return {
    no, title: "",
    subtitle: "",
    brief: "",
    type: "",
    en: "", accent: "#1C34C4",
    lead: "",
    desc: [""],
    sections: [
      { title: "", en: "", intro: "", entries: [] },
      { title: "", en: "", intro: "", entries: [{ k: "", v: "" }] },
    ],
    cast: DATA.characters.slice(0, 2).map((c) => ({ id: c.id })),
    relation: "",
  };
}

/* ==========================================================
   编辑面板（集合式表单）——「完全由面板取代行内编辑」
   ========================================================== */

/* 角色档案：人物志段落统一为 { title, text } 结构（兼容旧的纯文本段落） */
function normalizeCharacter(w) {
  w.tags = w.tags || [];
  w.quotes = w.quotes || [];
  w.intro = (w.intro || []).map((p) => paraOf(p));
  /* 代表色：色号可省略 #，保存时自动补全为 #RRGGBB */
  (w.colors || []).forEach((c) => { const p = parseHex(c.hex); if (p) c.hex = p; });
  delete w.voice;                   // 旧的全局名签配色已移除，改为每组对话单独设定（q.colors）
}

/* 关系档案：确保 calls / attitude / before 与当前 pair 对齐 */
function normalizeRel(w) {
  w.pair = (w.pair || []).slice(0, 2);
  w.hashtag = hashCore(w.hashtag);   // # 为自动装饰，存储只留名字本体
  w.tlColors = w.tlColors || {};     // 对话气泡配色（全时间线通用）
  w.qaColors = w.qaColors || {};     // 采访间回答者名签配色
  w.tags = w.tags || [];
  w.calls = w.calls || {};
  w.attitude = w.attitude || {};
  w.before = w.before || {};
  w.timeline = w.timeline || [];
  w.interview = w.interview || [];
  w.custom = w.custom || [];
  /* 票根 GATE 代表字：旧版整串 gate（含 ↔）迁移为左右两字 */
  w.custom.forEach((m) => {
    if (m && m.gate) {
      const [l, r] = String(m.gate).split("↔").map((s) => s.trim());
      if (!m.gateL) m.gateL = l || "";
      if (!m.gateR) m.gateR = r || "";
      delete m.gate;
    }
  });
  w.beforeNameCustom = w.beforeNameCustom || {};
  w.pair.forEach((id) => {
    if (typeof w.calls[id] !== "string") w.calls[id] = "—";
    if (!w.attitude[id] || typeof w.attitude[id] !== "object") w.attitude[id] = { surface: "—", inner: "—" };
    if (typeof w.before[id] !== "string") w.before[id] = "";
  });
  ["calls", "attitude", "before", "beforeNameCustom"].forEach((k) => {
    Object.keys(w[k]).forEach((id) => { if (!w.pair.includes(id)) delete w[k][id]; });
  });
}

/* 各类实体的面板配置 */
const ENTITY_PANELS = {
  character: {
    noun: "角色", canDelete: false,   /* 删除入口在编辑工具栏（详情页） */
    get: (i) => DATA.characters[i],
    set: (i, w) => { DATA.characters[i] = w; },
    remove: (i) => {
      const removed = DATA.characters.splice(i, 1)[0];
      if (removed) {
        DATA.relationships = DATA.relationships.filter((r) => !r.pair.includes(removed.id));
        DATA.worldviews.forEach((wv) => { wv.cast = wv.cast.filter((c) => c.id !== removed.id); });
      }
    },
    title: (w) => `编辑角色 · ${w.name || ""}`,
    normalize: normalizeCharacter,
    schema: () => [
      { type: "heading", label: "基本信息" },
      { type: "avatar", key: "avatar", label: "头像" },
      { type: "text", key: "name", label: "姓名" },
      { type: "text", key: "en", label: "英文名 / 拼音" },
      { type: "text", key: "mbti", label: "称号" },
      { type: "text", key: "alignment", label: "身份" },
      { type: "textarea", key: "oneLine", label: "导语" },
      { type: "heading", label: "标签" },
      { type: "stringList", key: "tags", label: "", addLabel: "标签" },
      { type: "heading", label: "基本资料" },
      { type: "keyval", key: "profile", label: "" },
      { type: "heading", label: "代表色" },
      { type: "colors", key: "colors", label: "" },
      { type: "heading", label: "人物志" },
      { type: "objlist", key: "intro", label: "", itemNoun: "段落", addLabel: "段落",
        newItem: () => ({ title: "", text: "" }),
        item: [
          { type: "text", key: "title", label: "小标题" },
          { type: "textarea", key: "text", label: "内容" },
        ] },
      { type: "heading", label: "语录" },
      { type: "quotes", key: "quotes", label: "" },
    ],
  },
  relationship: {
    noun: "关系", canDelete: false,   /* 删除入口在编辑工具栏（关系页） */
    get: (i) => DATA.relationships[i],
    set: (i, w) => { normalizeRel(w); DATA.relationships[i] = w; },
    remove: (i) => { DATA.relationships.splice(i, 1); },
    title: (w) => `编辑关系 · ${hashLabel(w.hashtag) || w.title || ""}`,
    normalize: normalizeRel,
    schema: (w) => {
      /* 配对双方的角色名，供对话 / 问答「直接插入角色名」选择（随配对实时刷新） */
      const pairNames = () => (w.pair || []).map(charById).filter(Boolean).map((c) => c.name);
      const sideLabels = () => {
        const [pa, pb] = (w.pair || []).map(charById);
        return { a: pa ? pa.name : "左侧（甲）", b: pb ? pb.name : "右侧（乙）" };
      };
      return [
      { type: "heading", label: "基本信息" },
      { type: "text", key: "title", label: "标题" },
      { type: "text", key: "hashtag", label: "CP名" },
      { type: "text", key: "en", label: "英文名" },
      { type: "textarea", key: "tagline", label: "一句话概括" },
      { type: "pair", key: "pair", label: "配对角色" },
      { type: "stringList", key: "tags", label: "关系标签", addLabel: "标签" },
      { type: "heading", label: "双方资料" },
      { type: "relPerChar" },
      { type: "heading", label: "遇到彼此之前" },
      { type: "select", key: "beforeNameColor", label: "标题角色名颜色", options: () => [
        { value: "theme", label: "角色卡主代表色" },
        { value: "voice", label: "语录对话代表色" },
        { value: "custom", label: "自定义颜色" },
      ] },
      { type: "relBeforeCustom", label: "自定义颜色" },
      { type: "relBefore" },
      { type: "heading", label: "时间线" },
      { type: "objlist", key: "timeline", label: "", itemNoun: "阶段", addLabel: "阶段", hideCount: true,
        newItem: () => ({ era: "", text: "", bubbles: [] }),
        item: [
          { type: "text", key: "era", label: "阶段" },
          { type: "textarea", key: "text", label: "描述" },
          { type: "objlist", key: "bubbles", label: "对话气泡", itemNoun: "气泡", addLabel: "气泡", hideCount: true,
            newItem: () => ({ side: "a", who: pairNames()[0] || "", text: "" }),
            item: [
              { type: "select", key: "side", label: "位置", options: () => [{ value: "a", label: "左" }, { value: "b", label: "右" }] },
              { type: "whoName", key: "who", label: "说话人", options: pairNames, placeholder: "选择角色" },
              { type: "textarea", key: "text", label: "台词" },
            ] },
        ] },
      { type: "tlColors", key: "tlColors", label: "对话气泡配色", sideLabels },
      { type: "heading", label: "访谈" },
      { type: "qaColors", key: "qaColors", label: "回答者名签配色", sideLabels },
      { type: "objlist", key: "interview", label: "", itemNoun: "问题", addLabel: "问题",
        newItem: () => ({ q: "", answers: [{ who: pairNames()[0] || "", text: "" }] }),
        item: [
          { type: "text", key: "q", label: "问题" },
          { type: "objlist", key: "answers", label: "回答", itemNoun: "回答", addLabel: "回答",
            newItem: () => ({ who: pairNames()[0] || "", text: "" }),
            item: [
              { type: "whoName", key: "who", label: "回答者", options: pairNames, placeholder: "选择角色" },
              { type: "textarea", key: "text", label: "回答" },
            ] },
        ] },
      { type: "heading", label: "自定义模块" },
      { type: "objlist", key: "custom", label: "", itemNoun: "模块", addLabel: "模块",
        newItem: () => ({ title: "", en: "", text: [""] }),
        item: [
          { type: "text", key: "title", label: "模块标题" },
          { type: "text", key: "en", label: "英文副标题" },
          { type: "text", key: "gateL", label: "GATE 左字", placeholder: "留空＝取角色甲名字首字" },
          { type: "text", key: "gateR", label: "GATE 右字", placeholder: "留空＝取角色乙名字首字" },
          { type: "stringList", key: "text", label: "段落", addLabel: "段落", textarea: true },
        ] },
      ];
    },
  },
  worldview: {
    noun: "世界观", canDelete: false,   /* 删除入口在编辑工具栏（世界观详情页） */
    get: (i) => DATA.worldviews[i],
    set: (i, w) => { DATA.worldviews[i] = w; },
    remove: (i) => { DATA.worldviews.splice(i, 1); },
    title: (w) => `编辑世界观 · ${w.title || ""}`,
    /* 详情页主色：色号可省略 #，保存时自动补全 */
    normalize: (w) => { const p = parseHex(w.accent); if (p) w.accent = p; },
    schema: () => [
      { type: "heading", label: "基本信息" },
      { type: "text", key: "no", label: "编号" },
      { type: "text", key: "title", label: "标题" },
      { type: "text", key: "en", label: "英文副标题" },
      { type: "text", key: "type", label: "类型" },
      { type: "text", key: "accent", label: "详情页主色" },
      { type: "text", key: "relation", label: "关系概括" },
      { type: "textarea", key: "lead", label: "一句话导语" },
      { type: "heading", label: "设定描述" },
      { type: "stringList", key: "desc", label: "", addLabel: "段落", textarea: true },
      { type: "heading", label: "模板板块" },
      { type: "objlist", key: "sections", label: "", itemNoun: "板块", addLabel: "模板板块",
        newItem: () => ({ title: "", en: "", intro: "", entries: [{ k: "", v: "" }] }),
        item: [
          { type: "text", key: "title", label: "板块标题" },
          { type: "text", key: "en", label: "英文副标题" },
          { type: "textarea", key: "intro", label: "引言段" },
          { type: "objlist", key: "entries", label: "词条", itemNoun: "词条", addLabel: "词条",
            newItem: () => ({ k: "", v: "" }),
            item: [
              { type: "text", key: "k", label: "词条名" },
              { type: "textarea", key: "v", label: "内容" },
            ] },
        ] },
      { type: "heading", label: "出场角色" },
      { type: "objlist", key: "cast", label: "", itemNoun: "角色", addLabel: "角色",
        newItem: () => ({ id: DATA.characters[0]?.id || "", role: "" }),
        item: [
          { type: "select", key: "id", label: "角色", options: () => DATA.characters.map((c) => ({ value: c.id, label: c.name })) },
          { type: "text", key: "role", label: "定位" },
        ] },
    ],
  },
};

/* ---------- 面板与表单渲染 ---------- */
function epFieldRow(label, control, help) {
  const row = document.createElement("div");
  row.className = "ep-field";
  if (label) {
    const l = document.createElement("label");
    l.className = "ep-label";
    l.textContent = label;
    if (help) { const h = document.createElement("span"); h.className = "ep-help"; h.textContent = help; l.appendChild(h); }
    row.appendChild(l);
  }
  row.appendChild(control);
  return row;
}
function epItemHead(title, onDel) {
  const h = document.createElement("div");
  h.className = "ep-item-head";
  if (title) { const s = document.createElement("span"); s.textContent = title; h.appendChild(s); }
  else h.classList.add("no-title");   // 无标题：只保留右上角删除
  const d = document.createElement("button"); d.type = "button"; d.className = "ep-mini del"; d.title = "删除"; d.setAttribute("aria-label", "删除"); d.textContent = "✕";
  d.addEventListener("click", onDel); h.appendChild(d);
  return h;
}
/* 名签配色编辑器（每组对话一份：双方各一行，含底色 + 文字色 + 恢复默认）
   色块点击后直接弹出输入框填十六进制色值（# 可省略）；
   store 只写入改动项；labelOf(k) 返回双方的实际角色名（自动读取，随输入刷新） */
function whoColorEditor(store, { labelOf, fallbackOf = () => ({}), onChange } = {}) {
  const box = document.createElement("div"); box.className = "ep-voice";
  const DEF = { bg: parseHex(cssColor("--ink")) || "#333333", text: parseHex(cssColor("--bg")) || "#FFFFFF" };
  const tags = {};
  ["a", "b"].forEach((k) => {
    const c = store[k] = store[k] || {};
    const inh = () => fallbackOf(k) || {};   // 该角色从别组继承来的配色
    const row = document.createElement("div"); row.className = "ep-color-row";
    const tag = document.createElement("span"); tag.className = "ep-color-role sub"; tags[k] = tag;
    row.appendChild(tag);
    const paints = [];
    [["bg", "底色"], ["text", "文字色"]].forEach(([prop, label]) => {
      const lab = document.createElement("span"); lab.className = "ep-voice-lab"; lab.textContent = label;
      const sw = document.createElement("button"); sw.type = "button"; sw.className = "ep-swatch";
      sw.title = `${label}：点击输入色值（如 #5E9EAE）`;
      /* 显示优先级：本组自设 → 继承自别组 → 默认 */
      const paint = () => { sw.style.background = parseHex(c[prop]) || parseHex(inh()[prop]) || DEF[prop]; };
      paint(); paints.push(paint);
      sw.addEventListener("click", () => {
        epPopInput(sw, {
          placeholder: "#5E9EAE",
          value: c[prop] || inh()[prop] || "",
          validate: (v) => !!parseHex(v),
          onSubmit: (v) => { c[prop] = parseHex(v); paint(); if (onChange) onChange(); },
        });
      });
      row.append(lab, sw);
    });
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "ep-mini del"; reset.textContent = "↺ 默认"; reset.title = "清除本组设定（改回继承或默认配色）";
    reset.addEventListener("click", () => {
      delete c.bg; delete c.text;
      paints.forEach((paint) => paint());
      if (onChange) onChange();
    });
    row.appendChild(reset);
    box.appendChild(row);
  });
  box.refreshLabels = () => { ["a", "b"].forEach((k) => { tags[k].textContent = labelOf(k); }); };
  box.refreshLabels();
  return box;
}

/* 按「角色名」跨角色卡聚合对话名签配色：某人在任何一张角色卡的对话里
   被设定过 bg / text，其它角色卡的同名说话人未自设时自动继承同一配色。
   cur（当前角色卡 / 编辑中的工作副本）的设定优先于其它卡；
   同一来源内以最早设定的那组为准。 */
function globalWhoColors(cur) {
  const map = {};
  const collect = (holder) => {
    ((holder && holder.quotes) || []).forEach((q) => {
      if (!Array.isArray(q.dialog)) return;
      const { a, b } = dialogParties(q.dialog);
      const qc = q.colors || {};
      [["a", a], ["b", b]].forEach(([k, name]) => {
        if (!name) return;
        const c = qc[k] || {};
        map[name] = map[name] || {};
        if (c.bg && !map[name].bg) map[name].bg = c.bg;
        if (c.text && !map[name].text) map[name].text = c.text;
      });
    });
  };
  collect(cur);
  DATA.characters.forEach((ch) => { if (!cur || ch.id !== cur.id) collect(ch); });
  return map;
}

/* 自绘迷你输入浮层（不使用浏览器原生 prompt）：
   Enter / ✔ 提交，Esc / 点外部取消；validate 不通过时输入框红框提示 */
function epPopInput(anchor, { placeholder = "", value = "", validate = null, onSubmit }) {
  document.querySelectorAll(".ep-pop").forEach((n) => n.remove());
  const pop = document.createElement("div"); pop.className = "ep-pop";
  const inp = document.createElement("input"); inp.className = "ep-input"; inp.placeholder = placeholder; inp.value = value;
  const ok = document.createElement("button"); ok.type = "button"; ok.className = "ep-pop-ok"; ok.textContent = "✔";
  pop.append(inp, ok);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(10, Math.min(r.left, window.innerWidth - pop.offsetWidth - 10)) + "px";
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 10) + "px";
  const onDoc = (e) => { if (!pop.contains(e.target)) close(); };
  const close = () => { pop.remove(); document.removeEventListener("pointerdown", onDoc, true); };
  document.addEventListener("pointerdown", onDoc, true);
  const submit = () => {
    const v = inp.value.trim();
    if (validate && !validate(v)) { inp.classList.add("err"); inp.focus(); return; }
    close(); onSubmit(v);
  };
  ok.addEventListener("click", submit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") close();
  });
  inp.addEventListener("input", () => inp.classList.remove("err"));
  inp.focus(); inp.select();
}

/* 自绘下拉（不使用浏览器原生选择框）：按钮 + 浮层菜单
   options() 每次展开时求值；onPick(value) 由调用方处理选中 */
function epDropdown({ value, options, onPick, className = "", placeholder = "" }) {
  const wrap = document.createElement("div"); wrap.className = ("ep-dd " + className).trim();
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "ep-input ep-dd-btn";
  const lab = document.createElement("span"); lab.className = "ep-dd-label" + (value ? "" : " empty");
  lab.textContent = value || placeholder;
  const caret = document.createElement("i"); caret.className = "ep-dd-caret"; caret.setAttribute("aria-hidden", "true");
  btn.append(lab, caret);
  const menu = document.createElement("div"); menu.className = "ep-dd-menu";
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const close = () => { wrap.classList.remove("open"); document.removeEventListener("pointerdown", onDoc, true); };
  btn.addEventListener("click", () => {
    if (wrap.classList.contains("open")) { close(); return; }
    menu.innerHTML = "";
    options().forEach((o) => {
      const it = document.createElement("button"); it.type = "button";
      it.className = "ep-dd-item" + (o.value === value ? " cur" : "") + (o.kind ? " " + o.kind : "");
      it.textContent = o.label;
      it.addEventListener("click", () => { close(); onPick(o.value); });
      menu.appendChild(it);
    });
    wrap.classList.add("open");
    document.addEventListener("pointerdown", onDoc, true);
  });
  wrap.append(btn, menu);
  return wrap;
}

function epSimpleRow(label, value, commit, textarea) {
  const ctrl = textarea ? document.createElement("textarea") : document.createElement("input");
  ctrl.className = "ep-input" + (textarea ? " ep-textarea" : "");
  if (textarea) ctrl.rows = 4;
  ctrl.value = value;
  ctrl.addEventListener("input", () => commit(ctrl.value));
  return epFieldRow(label, ctrl);
}

function renderField(f, work, rebuild) {
  switch (f.type) {
    case "heading": {
      const h = document.createElement("div"); h.className = "ep-sec"; h.textContent = f.label; return h;
    }
    case "text": {
      const inp = document.createElement("input"); inp.className = "ep-input"; inp.type = "text";
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.value = work[f.key] == null ? "" : work[f.key];
      inp.addEventListener("input", () => { work[f.key] = inp.value; });
      return epFieldRow(f.label, inp, f.help);
    }
    case "textarea": {
      const ta = document.createElement("textarea"); ta.className = "ep-input ep-textarea"; ta.rows = f.rows || 4;
      ta.value = work[f.key] == null ? "" : work[f.key];
      ta.addEventListener("input", () => { work[f.key] = ta.value; });
      return epFieldRow(f.label, ta, f.help);
    }
    case "avatar": {
      const box = document.createElement("div"); box.className = "ep-avatar";
      /* 预览框本身即上传/调整入口：点击选图 → 裁剪框调整 → 应用 */
      const prev = document.createElement("button"); prev.type = "button"; prev.className = "ep-avatar-prev";
      prev.title = "点击上传或调整头像";
      const paint = () => {
        prev.innerHTML = avatarHTML({ avatar: work[f.key], colors: work.colors || [], id: work.id || "x", name: work.name || "?" })
          + `<span class="ep-avatar-cam" aria-hidden="true"><i class="fa-solid fa-camera"></i></span>`;
      };
      paint();
      /* 点击预览框直接进入调整框（加载原图并还原上次构图，可继续调整）；无原图则先选图。
         裁剪成品存 avatar，原图存 avatarSrc，裁剪矩形存 avatarCrop（供下次还原） */
      prev.addEventListener("click", () => editAvatar(work, (r) => {
        work[f.key] = r.avatar; work.avatarSrc = r.src; work.avatarCrop = r.crop; paint();
      }));
      const btns = document.createElement("div"); btns.className = "ep-avatar-btns";
      const urlB = document.createElement("button"); urlB.type = "button"; urlB.className = "ep-mini"; urlB.textContent = "🖼 使用图床";
      urlB.addEventListener("click", () => {
        epPopInput(urlB, {
          placeholder: "图床图片地址（完整网址）",
          value: work[f.key] || "",
          /* 图床地址即最终头像，清掉本地原图/裁剪参数 */
          onSubmit: (u) => { work[f.key] = u; delete work.avatarSrc; delete work.avatarCrop; paint(); },
        });
      });
      btns.append(urlB);
      box.append(prev, btns);
      return epFieldRow(f.label, box, f.help);
    }
    case "select": {
      /* 自绘下拉替代原生 <select>，不再弹出浏览器原生选择框 */
      const opts0 = f.options();
      if (work[f.key] === undefined && opts0[0]) work[f.key] = opts0[0].value;
      const placeholder = f.placeholder || "请选择";
      const labelFor = (v) => { const o = f.options().find((o) => o.value === v); return o ? o.label : ""; };
      const dd = epDropdown({
        value: work[f.key] || "",
        placeholder,
        options: () => f.options(),
        onPick: (v) => {
          work[f.key] = v;
          const lab = dd.querySelector(".ep-dd-label");
          lab.textContent = labelFor(v) || placeholder;
          lab.classList.toggle("empty", !v);
        },
      });
      const lab = dd.querySelector(".ep-dd-label");
      lab.textContent = labelFor(work[f.key]) || placeholder;
      lab.classList.toggle("empty", !work[f.key]);
      return epFieldRow(f.label, dd, f.help);
    }
    case "pair": {
      const box = document.createElement("div"); box.className = "ep-pair";
      work.pair = work.pair || [];
      const nameFor = (id) => { const c = charById(id); return c ? c.name : ""; };
      [0, 1].forEach((pi) => {
        const dd = epDropdown({
          value: work.pair[pi] || "",
          placeholder: "选择角色",
          options: () => DATA.characters.map((c) => ({ value: c.id, label: c.name })),
          onPick: (v) => { work.pair[pi] = v; if (rebuild) rebuild(); },
        });
        const lab = dd.querySelector(".ep-dd-label");
        lab.textContent = nameFor(work.pair[pi]) || "选择角色";
        lab.classList.toggle("empty", !work.pair[pi]);
        box.appendChild(dd);
      });
      return epFieldRow(f.label, box, f.help);
    }
    case "stringList": {
      const box = document.createElement("div"); box.className = "ep-stringlist";
      const list = document.createElement("div");
      work[f.key] = work[f.key] || [];
      const render = () => {
        list.innerHTML = "";
        work[f.key].forEach((val, ii) => {
          const row = document.createElement("div"); row.className = "ep-sl-row";
          const ctrl = f.textarea ? document.createElement("textarea") : document.createElement("input");
          ctrl.className = "ep-input" + (f.textarea ? " ep-textarea" : ""); if (f.textarea) ctrl.rows = 4;
          ctrl.value = val;
          ctrl.addEventListener("input", () => { work[f.key][ii] = ctrl.value; });
          const del = document.createElement("button"); del.type = "button"; del.className = "ep-mini del"; del.textContent = "✕";
          del.addEventListener("click", () => { work[f.key].splice(ii, 1); render(); });
          row.append(ctrl, del); list.appendChild(row);
        });
      };
      render();
      const add = document.createElement("button"); add.type = "button"; add.className = "ep-mini add"; add.textContent = "＋ " + (f.addLabel || "添加");
      add.addEventListener("click", () => { work[f.key].push(""); render(); });
      box.append(list, add);
      return epFieldRow(f.label, box, f.help);
    }
    case "keyval": {
      const box = document.createElement("div"); box.className = "ep-kv";
      const list = document.createElement("div");
      const serialize = () => {
        const obj = {};
        list.querySelectorAll(".ep-kv-row").forEach((r) => {
          const k = r.querySelector(".kv-k").value.trim();
          if (k) obj[k] = r.querySelector(".kv-v").value;
        });
        work[f.key] = obj;
      };
      const kvRow = (k, v) => {
        const row = document.createElement("div"); row.className = "ep-kv-row";
        const kIn = document.createElement("input"); kIn.className = "ep-input kv-k"; kIn.placeholder = "项目名"; kIn.value = k;
        const vIn = document.createElement("input"); vIn.className = "ep-input kv-v"; vIn.placeholder = "内容"; vIn.value = v;
        const del = document.createElement("button"); del.type = "button"; del.className = "ep-mini del"; del.textContent = "✕";
        del.addEventListener("click", () => { row.remove(); serialize(); });
        row.append(kIn, vIn, del); return row;
      };
      Object.entries(work[f.key] || {}).forEach(([k, v]) => list.appendChild(kvRow(k, v)));
      list.addEventListener("input", serialize);
      const add = document.createElement("button"); add.type = "button"; add.className = "ep-mini add"; add.textContent = "＋ 添加一项";
      add.addEventListener("click", () => { const r = kvRow("", ""); list.appendChild(r); r.querySelector(".kv-k").focus(); });
      box.append(list, add);
      return epFieldRow(f.label, box, f.help);
    }
    case "colors": {
      const box = document.createElement("div"); box.className = "ep-colors";
      /* 标注哪个代表色决定 UI 配色：只有第 1 个（主题色）影响页面 */
      const note = document.createElement("div"); note.className = "ep-color-note";
      note.textContent = "第 1 个颜色是「主题色」——角色详情页的标题、装饰线、色块等 UI 配色都跟随它变化；其余颜色仅作为代表色展示，不影响页面配色。";
      const roleOf = (ii) => (ii === 0 ? "主题色" : String(ii + 1).padStart(2, "0"));
      const list = document.createElement("div");
      work[f.key] = work[f.key] || [];
      const render = () => {
        list.innerHTML = "";
        work[f.key].forEach((c, ii) => {
          const row = document.createElement("div"); row.className = "ep-color-row";
          const tag = document.createElement("span"); tag.className = "ep-color-role" + (ii === 0 ? "" : " sub"); tag.textContent = roleOf(ii);
          /* 色块：纯色按钮（无原生取色控件的白边），点击弹自绘输入浮层 */
          const col = document.createElement("button"); col.type = "button"; col.className = "ep-swatch";
          col.title = "点击输入色值（如 #5E9EAE）";
          const paint = () => { col.style.background = parseHex(c.hex) || "#888888"; };
          paint();
          const hx = document.createElement("input"); hx.className = "ep-input ep-hex"; hx.placeholder = "#RRGGBB"; hx.value = c.hex || "";
          col.addEventListener("click", () => {
            epPopInput(col, {
              placeholder: "#5E9EAE",
              value: c.hex || "",
              validate: (v) => !!parseHex(v),
              onSubmit: (v) => { c.hex = parseHex(v); hx.value = c.hex; paint(); },
            });
          });
          /* 色号可省略 #：输入时自动按补全后的标准值存储，失焦时补全输入框显示 */
          hx.addEventListener("input", () => { c.hex = parseHex(hx.value) || hx.value; paint(); });
          hx.addEventListener("blur", () => { const p = parseHex(hx.value); if (p) { c.hex = p; hx.value = p; paint(); } });
          const del = document.createElement("button"); del.type = "button"; del.className = "ep-mini del"; del.textContent = "✕";
          del.addEventListener("click", () => { work[f.key].splice(ii, 1); render(); });
          row.append(tag, col, hx, del); list.appendChild(row);
        });
      };
      render();
      const add = document.createElement("button"); add.type = "button"; add.className = "ep-mini add"; add.textContent = "＋ 颜色";
      add.addEventListener("click", () => { work[f.key].push({ hex: "#888888" }); render(); });
      box.append(note, list, add);
      return epFieldRow(f.label, box, f.help);
    }
    case "objlist": {
      const box = document.createElement("div"); box.className = "ep-objlist";
      const list = document.createElement("div");
      work[f.key] = work[f.key] || [];
      const render = () => {
        list.innerHTML = "";
        work[f.key].forEach((item, ii) => {
          const card = document.createElement("div"); card.className = "ep-item";
          card.appendChild(epItemHead(f.hideCount ? "" : (f.itemNoun || "条目") + " " + (ii + 1), () => { work[f.key].splice(ii, 1); render(); }));
          f.item.forEach((sf) => card.appendChild(renderField(sf, item, render)));
          list.appendChild(card);
        });
      };
      render();
      const add = document.createElement("button"); add.type = "button"; add.className = "ep-mini add"; add.textContent = "＋ " + (f.addLabel || "新增");
      add.addEventListener("click", () => { work[f.key].push(JSON.parse(JSON.stringify(f.newItem()))); render(); });
      box.append(list, add);
      return epFieldRow(f.label, box, f.help);
    }
    case "quotes": {
      const box = document.createElement("div"); box.className = "ep-quotes";
      const list = document.createElement("div");
      work[f.key] = work[f.key] || [];
      /* 已有的角色名：只读取这张角色卡里出现过的（本角色 + 各组对话的说话人） */
      const knownWhos = () => {
        const names = new Set();
        if (work.name) names.add(work.name);
        work[f.key].forEach((qq) => {
          if (Array.isArray(qq.dialog)) qq.dialog.forEach((l) => { if (l.who && l.who !== "？") names.add(l.who); });
        });
        return [...names];
      };
      const render = () => {
        list.innerHTML = "";
        work[f.key].forEach((q, ii) => {
          const card = document.createElement("div"); card.className = "ep-item";
          if (Array.isArray(q.dialog)) {
            card.appendChild(epItemHead("对话 " + (ii + 1), () => { work[f.key].splice(ii, 1); render(); }));
            const lines = document.createElement("div");
            /* 双方角色名自动读取自这组对话 */
            const partyA = () => dialogParties(q.dialog).a || work.name || "角色甲";
            const partyB = () => dialogParties(q.dialog).b || knownWhos().find((n) => n !== partyA()) || "角色乙";
            let colorBox = null;
            const addBar = document.createElement("div"); addBar.className = "ep-quote-adds";
            const mkAdd = (getWho) => {
              const btn = document.createElement("button"); btn.type = "button"; btn.className = "ep-mini add";
              btn.addEventListener("click", () => { q.dialog.push({ who: getWho(), text: "" }); renderLines(); });
              return btn;
            };
            const addA = mkAdd(partyA), addB = mkAdd(partyB);
            addBar.append(addA, addB);
            const refreshLabels = () => {
              addA.textContent = `＋ ${partyA()} 的一句`;
              addB.textContent = `＋ ${partyB()} 的一句`;
              if (colorBox) colorBox.refreshLabels();
            };
            const renderLines = () => {
              lines.innerHTML = "";
              q.dialog.forEach((ln, li) => {
                const row = document.createElement("div"); row.className = "ep-dl-row";
                /* 说话人：自绘下拉切换归属（只列出这张卡里出现过的角色），可选旁白或输入新名字 */
                const names = knownWhos();
                if (ln.who && !names.includes(ln.who)) names.unshift(ln.who);
                const who = epDropdown({
                  value: ln.who || "",
                  placeholder: "旁白",
                  className: "ep-dl-who",
                  options: () => [
                    ...names.map((n) => ({ value: n, label: n })),
                    { value: "", label: "旁白", kind: "muted" },
                    { value: "__new__", label: "✎ 输入新名字…", kind: "new" },
                  ],
                  onPick: (v) => {
                    if (v === "__new__") {
                      epPopInput(who, {
                        placeholder: "新的说话人名字",
                        validate: (val) => !!val,
                        onSubmit: (val) => { ln.who = val; renderLines(); },   // 重建各行下拉，让新名字进入所有候选
                      });
                      return;
                    }
                    ln.who = v;
                    renderLines();
                  },
                });
                const txt = document.createElement("input"); txt.className = "ep-input"; txt.placeholder = "台词"; txt.value = ln.text || "";
                txt.addEventListener("input", () => { ln.text = txt.value; });
                const del = document.createElement("button"); del.type = "button"; del.className = "ep-mini del"; del.textContent = "✕";
                del.addEventListener("click", () => { q.dialog.splice(li, 1); renderLines(); });
                row.append(who, txt, del); lines.appendChild(row);
              });
              refreshLabels();
            };
            renderLines();
            /* 本组名签配色：标签显示双方角色名；未自设时回退到该角色在别组
               （含其它角色卡）的继承色；任一处改色后整块重渲染，
               让继承同一角色的其它组色块同步变色 */
            const inheritMap = globalWhoColors(work);
            colorBox = whoColorEditor(q.colors = q.colors || {}, {
              labelOf: (k) => (k === "a" ? partyA() : partyB()),
              fallbackOf: (k) => inheritMap[k === "a" ? partyA() : partyB()] || {},
              onChange: render,
            });
            card.append(lines, addBar, colorBox);
          } else {
            card.appendChild(epItemHead("单人语录 " + (ii + 1), () => { work[f.key].splice(ii, 1); render(); }));
            card.appendChild(epSimpleRow("语录", q.text || "", (v) => { q.text = v; }, true));
          }
          list.appendChild(card);
        });
      };
      render();
      const adds = document.createElement("div"); adds.className = "ep-quote-adds";
      const addSolo = document.createElement("button"); addSolo.type = "button"; addSolo.className = "ep-mini add"; addSolo.textContent = "＋ 单人语录";
      addSolo.addEventListener("click", () => { work[f.key].push({ text: "" }); render(); });
      const addDlg = document.createElement("button"); addDlg.type = "button"; addDlg.className = "ep-mini add"; addDlg.textContent = "＋ 新增一组对话";
      addDlg.addEventListener("click", () => {
        /* 新对话组默认：本角色 × 这张卡里出现过的另一位角色 */
        const other = knownWhos().find((n) => n !== work.name);
        work[f.key].push({ dialog: [{ who: work.name || "", text: "" }, { who: other || "", text: "" }] });
        render();
      });
      adds.append(addSolo, addDlg);
      box.append(list, adds);
      return epFieldRow(f.label, box, f.help);
    }
    case "relPerChar": {
      /* 双方资料：称呼与表里态度（「遇到彼此之前」独立为 relBefore） */
      const box = document.createElement("div"); box.className = "ep-perchar";
      normalizeRel(work);
      work.pair.forEach((id) => {
        const ch = charById(id);
        const card = document.createElement("div"); card.className = "ep-item";
        const head = document.createElement("div"); head.className = "ep-item-head";
        const s = document.createElement("span"); s.textContent = ch ? ch.name : id; head.appendChild(s);
        card.appendChild(head);
        card.appendChild(epSimpleRow("对对方的称呼", work.calls[id] || "", (v) => { work.calls[id] = v; }));
        card.appendChild(epSimpleRow("表面态度", work.attitude[id].surface || "", (v) => { work.attitude[id].surface = v; }));
        card.appendChild(epSimpleRow("内心态度", work.attitude[id].inner || "", (v) => { work.attitude[id].inner = v; }));
        box.appendChild(card);
      });
      return epFieldRow(f.label || "", box, f.help);
    }
    case "relBeforeCustom": {
      /* 「遇到彼此之前」标题角色名的自定义颜色：双方各一个色块，
         选择「自定义颜色」模式时生效；未设定回退主代表色 */
      const box = document.createElement("div"); box.className = "ep-voice";
      normalizeRel(work);
      const store = work.beforeNameCustom = work.beforeNameCustom || {};
      work.pair.forEach((id) => {
        const ch = charById(id);
        const row = document.createElement("div"); row.className = "ep-color-row";
        const tag = document.createElement("span"); tag.className = "ep-color-role sub"; tag.textContent = ch ? ch.name : id;
        const sw = document.createElement("button"); sw.type = "button"; sw.className = "ep-swatch";
        sw.title = "点击输入色值（如 #5E9EAE）";
        const fallback = () => parseHex(ch && ch.colors && ch.colors[0] && ch.colors[0].hex) || "#888888";
        const paint = () => { sw.style.background = parseHex(store[id]) || fallback(); };
        paint();
        sw.addEventListener("click", () => {
          epPopInput(sw, {
            placeholder: "#5E9EAE",
            value: store[id] || "",
            validate: (v) => !!parseHex(v),
            onSubmit: (v) => { store[id] = parseHex(v); paint(); },
          });
        });
        const reset = document.createElement("button"); reset.type = "button"; reset.className = "ep-mini del"; reset.textContent = "↺ 默认";
        reset.addEventListener("click", () => { delete store[id]; paint(); });
        row.append(tag, sw, reset);
        box.appendChild(row);
      });
      return epFieldRow(f.label || "", box, f.help);
    }
    case "relBefore": {
      /* 遇到彼此之前：双方各一段（独立板块，不属于双方资料） */
      const box = document.createElement("div"); box.className = "ep-perchar";
      normalizeRel(work);
      work.pair.forEach((id) => {
        const ch = charById(id);
        const other = charById(work.pair.find((x) => x !== id));
        const card = document.createElement("div"); card.className = "ep-item";
        const head = document.createElement("div"); head.className = "ep-item-head";
        const s = document.createElement("span");
        s.textContent = `遇到${other ? other.name : "对方"}之前的${ch ? ch.name : id}`;
        head.appendChild(s);
        card.appendChild(head);
        card.appendChild(epSimpleRow("", work.before[id] || "", (v) => { work.before[id] = v; }, true));
        box.appendChild(card);
      });
      return epFieldRow(f.label || "", box, f.help);
    }
    case "whoName": {
      /* 说话人 / 回答者：下拉直接插入配对角色名，也可输入新名字（参考角色页对话） */
      const placeholder = f.placeholder || "选择角色";
      const dd = epDropdown({
        value: work[f.key] || "",
        placeholder,
        className: "ep-dl-who",
        options: () => {
          const names = f.options ? f.options() : [];
          const cur = work[f.key];
          if (cur && !names.includes(cur)) names.unshift(cur);
          return [
            ...names.map((n) => ({ value: n, label: n })),
            { value: "__new__", label: "✎ 输入新名字…", kind: "new" },
          ];
        },
        onPick: (v) => {
          const setVal = (val) => {
            work[f.key] = val;
            const lab = dd.querySelector(".ep-dd-label");
            lab.textContent = val || placeholder;
            lab.classList.toggle("empty", !val);
          };
          if (v === "__new__") {
            epPopInput(dd, { placeholder: "新的名字", validate: (val) => !!val, onSubmit: setVal });
            return;
          }
          setVal(v);
        },
      });
      return epFieldRow(f.label, dd, f.help);
    }
    case "qaColors": {
      /* 采访间回答者名签配色：甲乙两侧各可调底色 / 文字色；
         未自设时回退到该角色在角色卡对话里的继承色 */
      normalizeRel(work);
      const labels = f.sideLabels ? f.sideLabels() : { a: "左侧（甲）", b: "右侧（乙）" };
      const g = globalWhoColors();
      const box = whoColorEditor(work[f.key] = work[f.key] || {}, {
        labelOf: (k) => labels[k],
        fallbackOf: (k) => g[labels[k]] || {},
      });
      return epFieldRow(f.label, box, f.help);
    }
    case "tlColors": {
      /* 时间线对话气泡配色：全时间线通用（一份）。甲 / 乙两侧各可调气泡底色与
         文字色；未自设时回退到该角色在角色卡对话里的继承色，再回退默认气泡色 */
      const store = work[f.key] = work[f.key] || {};
      const labels = f.sideLabels ? f.sideLabels() : { a: "左侧（甲）", b: "右侧（乙）" };
      const g = globalWhoColors();
      const inh = (k) => g[labels[k]] || {};
      const DEF = {
        a: { bg: parseHex(cssColor("--bubble-a")) || "#E5EFB3", text: parseHex(cssColor("--ink")) || "#2D3A30" },
        b: { bg: parseHex(cssColor("--bubble-b")) || "#D9EAD9", text: parseHex(cssColor("--ink")) || "#2D3A30" },
      };
      const PROPS = [["bg", "气泡底色"], ["text", "文字色"]];
      const box = document.createElement("div"); box.className = "ep-tlc";
      ["a", "b"].forEach((k) => {
        const c = store[k] = store[k] || {};
        const side = document.createElement("div"); side.className = "ep-tlc-side";
        const tag = document.createElement("span"); tag.className = "ep-color-role sub"; tag.textContent = labels[k];
        side.appendChild(tag);
        const grid = document.createElement("div"); grid.className = "ep-tlc-grid";
        PROPS.forEach(([prop, label]) => {
          const item = document.createElement("div"); item.className = "ep-tlc-item";
          const sw = document.createElement("button"); sw.type = "button"; sw.className = "ep-swatch";
          sw.title = `${label}：点击输入色值（如 #5E9EAE）`;
          const paint = () => { sw.style.background = parseHex(c[prop]) || parseHex(inh(k)[prop]) || DEF[k][prop]; };
          paint();
          sw.addEventListener("click", () => {
            epPopInput(sw, {
              placeholder: "#5E9EAE",
              value: c[prop] || "",
              validate: (v) => !!parseHex(v),
              onSubmit: (v) => { c[prop] = parseHex(v); paint(); },
            });
          });
          const name = document.createElement("span"); name.className = "ep-tlc-name"; name.textContent = label;
          item.append(sw, name);   // 上方色块，下方名称
          grid.appendChild(item);
        });
        side.appendChild(grid);
        box.appendChild(side);
      });
      return epFieldRow(f.label, box, f.help);
    }
    default:
      return document.createComment("unknown field: " + f.type);
  }
}

function openEntityPanel(kind, idx) {
  const conf = ENTITY_PANELS[kind];
  if (!conf) return;
  const src = conf.get(idx);
  if (!src) return;
  const work = JSON.parse(JSON.stringify(src));   // 工作副本：保存时才写回 DATA
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor ep-overlay";
  wrap.innerHTML = `
    <div class="ae-panel ep-panel">
      <div class="ep-head">
        <div class="ep-title"><i class="fa-solid fa-pen-to-square"></i> <span></span></div>
        <button type="button" class="ep-x" title="关闭">✕</button>
      </div>
      <div class="ep-body"></div>
      <div class="ep-foot">
        ${conf.canDelete ? `<button type="button" class="ep-del">🗑 删除此${esc(conf.noun)}</button>` : "<span></span>"}
        <div class="ep-foot-r">
          <button type="button" class="ep-cancel">取消</button>
          <button type="button" class="ep-save">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector(".ep-body");
  const titleEl = wrap.querySelector(".ep-title span");
  const rebuild = () => {
    if (conf.normalize) conf.normalize(work);
    titleEl.textContent = conf.title(work, idx);
    body.innerHTML = "";
    conf.schema(work).forEach((f) => body.appendChild(renderField(f, work, rebuild)));
  };
  rebuild();

  const close = () => wrap.remove();
  wrap.querySelector(".ep-x").addEventListener("click", close);
  wrap.querySelector(".ep-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector(".ep-save").addEventListener("click", () => {
    if (conf.normalize) conf.normalize(work);
    const backup = JSON.stringify(DATA);
    conf.set(idx, work);
    try {
      saveData();
    } catch (err) {
      /* 超出浏览器存储配额（多为头像原图过大）：优先只丢弃原图（保留成品头像），
         保住这次的其它编辑，而不是整体回滚。丢原图仍存不下才整体回滚。 */
      const saved = conf.get(idx);
      if (saved && saved.avatarSrc) {
        delete saved.avatarSrc; delete saved.avatarCrop;
        try {
          saveData();
          close(); renderAll();
          uiNotice("头像原图太大、浏览器存不下，已改为只保存裁剪后的头像。\n（刷新后将无法再从原图重新裁剪；如需可编辑原图，请换用体积更小的图片或使用图床。）");
          return;
        } catch (e2) { /* 仍失败 → 整体回滚 */ }
      }
      DATA = JSON.parse(backup);
      saveData();
      uiNotice("内容过大，浏览器存储空间不足。这次修改未能保存，请换小一点的图片。");
      return;
    }
    close();
    renderAll();
  });
  const delEl = wrap.querySelector(".ep-del");
  if (delEl) delEl.addEventListener("click", () => {
    uiConfirm(`确定删除此${conf.noun}？此操作不可撤销。`, () => {
      conf.remove(idx);
      saveData(); close(); renderAll();
    });
  });
}

/* ==========================================================
   事件（全局委托）
   ========================================================== */
document.addEventListener("click", (e) => {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (!t) return;

  if (t.closest("#editToggle") || t.id === "btnDone") {
    if (EDIT) {
      /* 退出编辑：无需验证 */
      EDIT = false;
      localStorage.setItem("oc-edit", "");
      renderAll();
    } else {
      /* 进入编辑：输入统一口令（联网交服务器校验，离线走本机校验） */
      requestEditUnlock(() => {
        EDIT = true;
        localStorage.setItem("oc-edit", "1");
        renderAll();
      });
    }
    return;
  }
  if (t.id === "btnExport") { exportDataJs(); return; }
  if (t.id === "btnImport") { importDataJs(); return; }
  if (t.closest("#syncPill")) { openSyncPanel(); return; }
  const dlBtn = t.closest("#btnCardPng");
  if (dlBtn) { downloadCardPNG(dlBtn); return; }
  const relPngBtn = t.closest("#btnRelPng");
  if (relPngBtn) { downloadRelPNG(relPngBtn); return; }
  const wvdPngBtn = t.closest("#btnWvdPng");
  if (wvdPngBtn) { downloadWvdPNG(wvdPngBtn); return; }
  if (t.closest("#btnCardTxt")) { downloadCardTXT(); return; }
  if (t.closest("#btnRelTxt")) { downloadRelTXT(); return; }
  if (t.closest("#btnWvdTxt")) { downloadWvdTXT(); return; }

  if (!EDIT) return;

  /* 删除当前角色：两次点击确认（不弹原生对话框） */
  const delChar = t.closest("#btnDelChar");
  if (delChar) {
    if (!delChar.classList.contains("arm")) {
      delChar.classList.add("arm");
      delChar.innerHTML = '再点一次确认删除';
      setTimeout(() => {
        if (delChar.isConnected) {
          delChar.classList.remove("arm");
          delChar.innerHTML = '删除';
        }
      }, 3000);
      return;
    }
    const i = DATA.characters.findIndex((c) => c.id === delChar.dataset.char);
    if (i >= 0) { ENTITY_PANELS.character.remove(i); saveDataThen(() => { location.href = "character.html"; }); return; }
    location.href = "character.html";
    return;
  }

  /* 删除当前关系：两次点击确认（与删除角色一致，不弹原生对话框） */
  const delRel = t.closest("#btnDelRel");
  if (delRel) {
    if (!delRel.classList.contains("arm")) {
      delRel.classList.add("arm");
      delRel.innerHTML = '再点一次确认删除';
      setTimeout(() => {
        if (delRel.isConnected) {
          delRel.classList.remove("arm");
          delRel.innerHTML = '删除';
        }
      }, 3000);
      return;
    }
    const i = DATA.relationships.findIndex((r) => r.id === delRel.dataset.rel);
    if (i >= 0) { ENTITY_PANELS.relationship.remove(i); saveDataThen(() => { location.href = "relationship.html"; }); return; }
    location.href = "relationship.html";
    return;
  }

  /* 删除当前世界观：两次点击确认（与删除角色 / 关系一致） */
  const delWv = t.closest("#btnDelWv");
  if (delWv) {
    if (!delWv.classList.contains("arm")) {
      delWv.classList.add("arm");
      delWv.innerHTML = '再点一次确认删除';
      setTimeout(() => {
        if (delWv.isConnected) {
          delWv.classList.remove("arm");
          delWv.innerHTML = '删除';
        }
      }, 3000);
      return;
    }
    const i = parseInt(delWv.dataset.wv, 10);
    if (i >= 0 && DATA.worldviews[i]) { ENTITY_PANELS.worldview.remove(i); saveDataThen(() => { location.href = "worldview.html"; }); return; }
    location.href = "worldview.html";
    return;
  }

  /* 角色卡 / 关系页分部编辑：只打开该部分的小编辑框 */
  const cpart = t.closest("[data-char-part]");
  if (cpart) {
    e.preventDefault(); e.stopPropagation();
    const { idx, part } = JSON.parse(cpart.dataset.charPart);
    openCharPart(idx, part);
    return;
  }
  const rpart = t.closest("[data-rel-part]");
  if (rpart) {
    e.preventDefault(); e.stopPropagation();
    const { idx, part } = JSON.parse(rpart.dataset.relPart);
    openRelPart(idx, part);
    return;
  }
  /* 关系页时间线：单阶段编辑 / 删除 / 新增 */
  const rstage = t.closest("[data-rel-stage]");
  if (rstage) {
    e.preventDefault(); e.stopPropagation();
    const { idx, ti } = JSON.parse(rstage.dataset.relStage);
    openRelStagePanel(idx, ti);
    return;
  }
  const rstageDel = t.closest("[data-rel-stage-del]");
  if (rstageDel) {
    e.preventDefault(); e.stopPropagation();
    const { idx, ti } = JSON.parse(rstageDel.dataset.relStageDel);
    const rel = DATA.relationships[idx];
    if (!rel || !rel.timeline || !rel.timeline[ti]) return;
    uiConfirm(`确定删除阶段「${rel.timeline[ti].era || ""}」？`, () => {
      rel.timeline.splice(ti, 1);
      saveData(); renderAll();
    });
    return;
  }
  /* 关系页采访间：单问题编辑 / 删除 / 新增 */
  const rqa = t.closest("[data-rel-qa]");
  if (rqa) {
    e.preventDefault(); e.stopPropagation();
    const { idx, qi } = JSON.parse(rqa.dataset.relQa);
    openRelQaPanel(idx, qi);
    return;
  }
  const rqaDel = t.closest("[data-rel-qa-del]");
  if (rqaDel) {
    e.preventDefault(); e.stopPropagation();
    const { idx, qi } = JSON.parse(rqaDel.dataset.relQaDel);
    const rel = DATA.relationships[idx];
    if (!rel || !rel.interview || !rel.interview[qi]) return;
    uiConfirm(`确定删除问题「${rel.interview[qi].q || ""}」？`, () => {
      rel.interview.splice(qi, 1);
      saveData(); renderAll();
    });
    return;
  }
  const addQa = t.closest("#relAddQa");
  if (addQa) {
    const ri = parseInt(addQa.dataset.relIdx, 10);
    const rel = DATA.relationships[ri];
    if (!rel) return;
    const names = (rel.pair || []).map(charById).filter(Boolean).map((c) => c.name);
    (rel.interview = rel.interview || []).push({ q: "", answers: names.map((n) => ({ who: n, text: "" })) });
    saveData(); renderAll();
    openRelQaPanel(ri, rel.interview.length - 1);
    return;
  }
  const addStage = t.closest("#relAddStage");
  if (addStage) {
    const ri = parseInt(addStage.dataset.relIdx, 10);
    const rel = DATA.relationships[ri];
    if (!rel) return;
    (rel.timeline = rel.timeline || []).push({ era: "", text: "", bubbles: [] });
    saveData(); renderAll();
    openRelStagePanel(ri, rel.timeline.length - 1);
    return;
  }
  /* 关系页自定义模块：单模块编辑 / 删除 / 新增 */
  const rmod = t.closest("[data-rel-module]");
  if (rmod) {
    e.preventDefault(); e.stopPropagation();
    const { idx, mi } = JSON.parse(rmod.dataset.relModule);
    openRelModulePanel(idx, mi);
    return;
  }
  const rmodDel = t.closest("[data-rel-module-del]");
  if (rmodDel) {
    e.preventDefault(); e.stopPropagation();
    const { idx, mi } = JSON.parse(rmodDel.dataset.relModuleDel);
    const rel = DATA.relationships[idx];
    if (!rel || !rel.custom || !rel.custom[mi]) return;
    uiConfirm(`确定删除模块「${rel.custom[mi].title || ""}」？`, () => {
      rel.custom.splice(mi, 1);
      saveData(); renderAll();
    });
    return;
  }
  const addMod = t.closest("#relAddModule");
  if (addMod) {
    const rel = DATA.relationships[parseInt(addMod.dataset.relIdx, 10)];
    if (!rel) return;
    (rel.custom = rel.custom || []).push({ title: "", en: "", text: [""] });
    saveData(); renderAll();
    openRelModulePanel(parseInt(addMod.dataset.relIdx, 10), rel.custom.length - 1);
    return;
  }

  /* 世界观记录册卡片：受限编辑框（只含 标题 / 副标题 / 简介 / 出场角色） */
  const wvcard = t.closest("[data-wvcard]");
  if (wvcard) {
    e.preventDefault(); e.stopPropagation();
    const wi = +wvcard.dataset.wvcard;
    if (DATA.worldviews[wi]) openWvCardPanel(DATA.worldviews[wi], wi);
    return;
  }

  /* 打开某个实体的编辑面板 */
  const open = t.closest("[data-panel]");
  if (open) {
    e.preventDefault(); e.stopPropagation();
    const { kind, idx } = JSON.parse(open.dataset.panel);
    openEntityPanel(kind, idx);
    return;
  }

  /* 新增某类实体后立即打开其面板 */
  const addNew = t.closest("[data-panel-add]");
  if (addNew) {
    e.preventDefault(); e.stopPropagation();
    const { kind } = JSON.parse(addNew.dataset.panelAdd);
    let made;
    if (kind === "character") { made = newCharacter(); DATA.characters.push(made); }
    else if (kind === "relationship") { made = newRelationship(); if (!made) return; DATA.relationships.push(made); }
    else if (kind === "worldview") { made = newWorldview(); DATA.worldviews.push(made); }
    saveData(); renderAll();
    const list = kind === "character" ? DATA.characters : kind === "relationship" ? DATA.relationships : DATA.worldviews;
    openEntityPanel(kind, list.length - 1);
    return;
  }

  /* 编辑模式下阻止卡片链接跳转，避免误触（「查看档案 →」仍可点击跳转） */
  const link = t.closest("a");
  if (link && link.closest(".char-card, .cast-item") && !t.closest(".go")) {
    e.preventDefault();
  }
});

/* ---------- 上传头像：选择本地图片 → 弹出编辑框裁剪缩放 → 回调裁剪结果 ---------- */
/* 选一张本地图片 → 回调 (img, objectURL, keepAlpha)；失败回调 onErr */
function pickImageFile(onPick) {
  const input = document.createElement("input");
  input.type = "file";           // 不限制文件类型，可浏览所有文件
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => onPick(img, url, /png|gif|webp|svg/i.test(file.type));
    img.onerror = () => { URL.revokeObjectURL(url); uiNotice("图片读取失败，请换一张试试。"); };
    img.src = url;
  };
  input.click();
}

/* 把整张图缩放到最长边 maxSide 以内后转 dataURL（作为可反复裁剪的「原图」持久保存） */
function imageToCappedDataURL(img, maxSide, keepAlpha) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(img, 0, 0, cw, ch);
  return c.toDataURL(keepAlpha ? "image/png" : "image/jpeg", 0.82);
}

/* 选本地图片 → 裁剪框（无还原参数：从头构图） */
function pickAvatar(commit) {
  pickImageFile((img, url, keepAlpha) => openAvatarEditor({ img, url, keepAlpha, commit }));
}

/* 打开头像调整框：优先加载「原图」并还原上次裁剪构图，可继续自由平移缩放；
   没有原图时退回选图。commit 收到 { avatar, src, crop, keepAlpha } */
function editAvatar(work, commit) {
  const hasRealSrc = !!work.avatarSrc;
  const src = work.avatarSrc || work.avatar;   // 优先用保存的原图；兼容只有成品图的旧数据
  if (!src) { pickAvatar(commit); return; }
  const isData = /^data:/.test(src);
  const img = new Image();
  if (!isData) img.crossOrigin = "anonymous";
  img.onload = () => openAvatarEditor({
    img, url: src,
    keepAlpha: /\.png|\.gif|\.webp|\.svg|image\/png/i.test(src),
    commit, editingExisting: true,
    /* 打开即还原到已设定的裁剪构图（预览与当前头像一致），仍可自由缩放原图重新构图 */
    restore: hasRealSrc ? work.avatarCrop : null,
    reuseSrc: hasRealSrc ? src : null,   // 仅当是真·原图时复用；旧数据只有成品图则重新生成
  });
  img.onerror = () => pickAvatar(commit);   // 现有图加载失败（如跨域禁止）→ 直接选新图
  img.src = src;
}

/* 头像编辑框：拖动调整位置、滑杆/滚轮自由缩放，方形预览裁剪；
   确认后 commit({ avatar: 裁剪成品, src: 原图, crop: 裁剪矩形, keepAlpha })。
   restore 传入上次裁剪矩形（原图像素坐标）以还原构图；reuseSrc 为已有 dataURL 原图（复用不重编码）。 */
function openAvatarEditor({ img, url, keepAlpha, commit, editingExisting, restore, reuseSrc }) {
  const V = Math.min(400, Math.max(240, window.innerWidth - 88));   // 裁剪框边长（px）
  const minScale = Math.max(V / img.naturalWidth, V / img.naturalHeight);
  const MAXZ = 400;                    // 最大放大 400%
  let scale, ox, oy;
  /* 还原上次构图：裁剪矩形以「归一化比例」保存（与像素尺寸无关，兼容压缩后的原图）。
     兼容旧字段 sx/sy/sSize（仅当未压缩、坐标系一致时才正确）。 */
  const nw = img.naturalWidth, nh = img.naturalHeight;
  let rSize = 0, rx = 0, ry = 0;
  if (restore && restore.fSize > 0) { rSize = restore.fSize * nw; rx = restore.fx * nw; ry = restore.fy * nh; }
  else if (restore && restore.sSize > 0) { rSize = restore.sSize; rx = restore.sx; ry = restore.sy; }
  if (rSize > 0) {
    scale = Math.max(minScale, V / rSize);
    ox = -rx * scale;
    oy = -ry * scale;
  } else {
    scale = minScale;
    ox = (V - nw * scale) / 2;
    oy = (V - nh * scale) / 2;
  }

  const wrap = document.createElement("div");
  wrap.className = "avatar-editor";
  wrap.innerHTML = `
    <div class="ae-panel">
      <div class="ae-stage"><img src="${esc(url)}" alt="" draggable="false"><div class="ae-ring"></div></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel">取消</button>
        <button type="button" class="ae-swap">🖼 更换图片</button>
        <button type="button" class="ae-ok">✔ 使用头像</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const stage = wrap.querySelector(".ae-stage");
  const pic = wrap.querySelector(".ae-stage img");
  stage.style.width = V + "px";
  stage.style.height = V + "px";

  function apply() {
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ox = Math.min(0, Math.max(ox, V - w));
    oy = Math.min(0, Math.max(oy, V - h));
    pic.style.width = w + "px";
    pic.style.left = ox + "px";
    pic.style.top = oy + "px";
  }
  /* 以 (ax, ay)（裁剪框内坐标）为锚点缩放 */
  function setScaleAt(s, ax, ay) {
    s = Math.min(minScale * MAXZ / 100, Math.max(minScale, s));
    const cx = (ax - ox) / scale, cy = (ay - oy) / scale;
    scale = s;
    ox = ax - cx * scale;
    oy = ay - cy * scale;
    apply();
  }
  apply();

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    setScaleAt(scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  /* 单指拖动移动位置，双指捏合修改大小 */
  const pts = new Map();
  let drag = null, pinch = null;
  const pinchInfo = () => {
    const [p1, p2] = [...pts.values()];
    return { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), midX: (p1.x + p2.x) / 2, midY: (p1.y + p2.y) / 2 };
  };
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      drag = { x: e.clientX - ox, y: e.clientY - oy };
    } else if (pts.size === 2) {
      drag = null;
      pinch = { startDist: pinchInfo().dist, startScale: scale };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const { dist, midX, midY } = pinchInfo();
      const r = stage.getBoundingClientRect();
      setScaleAt(pinch.startScale * dist / pinch.startDist, midX - r.left, midY - r.top);
    } else if (drag) {
      ox = e.clientX - drag.x;
      oy = e.clientY - drag.y;
      apply();
    }
  });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) {
      const p = [...pts.values()][0];
      drag = { x: p.x - ox, y: p.y - oy };
    } else {
      drag = null;
    }
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);

  function close() { URL.revokeObjectURL(url); wrap.remove(); }
  wrap.querySelector(".ae-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  /* 更换图片：选新图后关掉当前框、以新图重开（保留同一个 commit，不带还原参数） */
  wrap.querySelector(".ae-swap").addEventListener("click", () => {
    pickImageFile((nImg, nUrl, nKeep) => { close(); openAvatarEditor({ img: nImg, url: nUrl, keepAlpha: nKeep, commit }); });
  });
  wrap.querySelector(".ae-ok").addEventListener("click", () => {
    const SIZE = 256;
    const sx = -ox / scale, sy = -oy / scale, sSize = V / scale;   // 原图坐标系里的裁剪矩形
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, SIZE, SIZE);
    let avatar, srcData;
    try {
      avatar = canvas.toDataURL(keepAlpha ? "image/png" : "image/jpeg", 0.86);
      /* 保存原图以便日后继续调整：已是 dataURL 的直接复用，否则缩放到 1000px、
         统一用 JPEG 压缩存一份（控制体积，避免占满 localStorage） */
      srcData = reuseSrc || imageToCappedDataURL(img, 1000, false);
    } catch (e) {
      /* 现有远程图跨域受限、画布被污染，无法导出 → 保留原地址即可 */
      uiNotice("这张网络图片不支持裁剪导出，将直接使用原图。如需裁剪请改用「更换图片」上传本地图片。");
      close();
      return;
    }
    close();
    /* 裁剪矩形以归一化比例保存，与原图像素尺寸/是否压缩无关，重开可精确还原 */
    const crop = { fx: sx / img.naturalWidth, fy: sy / img.naturalHeight, fSize: sSize / img.naturalWidth };
    if (typeof commit === "function") commit({ avatar, src: srcData, crop, keepAlpha });
  });
}

/* ==========================================================
   导出 PNG（角色卡 / 关系详情页 / 世界观详情页，下载前先预览）
   用 modern-screenshot（js/vendor/modern-screenshot.js，全局
   modernScreenshot）把节点光栅化为两倍分辨率 PNG。克隆节点、内联
   计算样式与伪元素、内嵌 @font-face 网络字体与图片都由该库处理，
   这里只负责：① 剔除切换导航 / 编辑按钮等交互元素；
   ② 对屏幕上单行的文本 / 标签容器强制 nowrap，避免导出时字体度量
   略宽导致的异常换行。
   ========================================================== */
/* 网页交互元素（编辑 / 切换 / 返回链接等）一律不进图 */
const PNG_EXCLUDE = ".fms-next, .fmn-next, .ep-open, .ep-add, .ep-mini, .wve-edit, .wve-del, .wvd-add, .wvd-more, .back-link, .style-switch, .selector, .part-add, .cpart-bar";

/* PNG 预览框：先看效果，确认后再下载 */
function previewPNG(blob, filename) {
  const url = URL.createObjectURL(blob);
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor";
  wrap.innerHTML = `
    <div class="ae-panel pngp-panel">
      <div class="pngp-head"><i class="fa-solid fa-image"></i> PNG 预览<span class="pngp-name"></span></div>
      <div class="pngp-stage"><img alt="PNG 预览"></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel">取消</button>
        <button type="button" class="ae-ok pngp-dl"><i class="fa-solid fa-download"></i> 下载 PNG</button>
      </div>
    </div>`;
  wrap.querySelector(".pngp-name").textContent = filename;
  wrap.querySelector("img").src = url;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); URL.revokeObjectURL(url); };
  wrap.querySelector(".ae-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector(".pngp-dl").addEventListener("click", () => {
    const aEl = document.createElement("a");
    aEl.download = filename;
    aEl.href = url;
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    wrap.remove();
    /* 延迟释放 blob URL，确保浏览器已用 download 文件名接管下载 */
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
}

/* 通用导出：把 node 光栅化为 PNG 并打开预览框（角色卡 / 关系页 / 世界观详情通用）
   bg 为导出底色（null＝透明，角色卡用；整页导出传页面底色）；
   hideSel 匹配的区域整块不进图（导出期间临时 display:none，宽高随之自动收敛，
   导出结束恢复）——用于剔除页面大标题、末尾切换导航、返回链接等。 */
async function exportNodePNG(btn, { node, filename, bg = null, hideSel = "" }) {
  if (!node) return;
  if (!(window.modernScreenshot && modernScreenshot.domToBlob)) {
    uiNotice("截图组件未加载，请刷新后重试。");
    return;
  }
  const card = node;
  const oldHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "⏳ 正在生成…";
  /* 导出前在原节点上按屏幕实测打标（类名无对应 CSS 规则，不影响网页布局），
     克隆时据此对相应节点强制 nowrap；导出结束在 finally 里清除。 */
  const marked = [];
  const hidden = [];
  const tightened = [];
  let wm = null;
  try {
    await document.fonts.ready;

    /* 不进图的区域先整块隐藏，后续单行判定与宽高测量都以隐藏后的布局为准 */
    if (hideSel) card.querySelectorAll(hideSel).forEach((el) => {
      hidden.push([el, el.style.display]);
      el.style.display = "none";
    });

    /* 编辑模式的按钮等交互元素由 filter 从克隆中剔除、不进图，但它们
       在页面上占位、会被计入导出高度——图底就多出等高的一片空白
       （编辑模式下导出「底部留白过多」的根源）。导出期间一并隐藏再量高。 */
    card.querySelectorAll(PNG_EXCLUDE).forEach((el) => {
      hidden.push([el, el.style.display]);
      el.style.display = "none";
    });

    /* 底部留白压缩（仅导出期间生效，结束恢复）：
       世界观详情页的页脚上下留白在图里显得过大，贴紧一些 */
    const tighten = (sel, prop, val) => card.querySelectorAll(sel).forEach((el) => {
      tightened.push([el, prop, el.style[prop]]); el.style[prop] = val;
    });
    tighten(".wvd-body", "paddingBottom", "6px");
    tighten(".wvd-foot", "marginTop", "22px");
    /* 顶部首个可见子元素的 margin-top 在网页上与卡片折叠、不计入高度，
       但克隆渲染的 foreignObject 里不折叠——内容整体下移，底部（水印）
       会被挤出图外。导出期间给卡片建 BFC，让量高与克隆渲染一致。 */
    tightened.push([card, "overflow", card.style.overflow]);
    card.style.overflow = "hidden";

    /* 所有导出 PNG 底部加署名水印（居中花括号式：{ 由 琉璃 设计 } ● 账号）。
       配色自适应卡片墨色 / 底色；挂到真实 DOM 末尾走正常克隆管线
       （字体嵌入 / 样式内联），量高精确，导出结束移除。
       角色卡挂进黑框主体内，负 margin 吃掉内边距、贴边框通栏。 */
    const wmBox = card.querySelector(".fms-box, .fmn-stage") || card;
    const bcs = getComputedStyle(wmBox);
    const wmC = bcs.color;
    const wmB = bg || (/rgba\(0, 0, 0, 0\)|transparent/.test(bcs.backgroundColor) ? cssColor("--bg") : bcs.backgroundColor);
    const wmA = `color-mix(in srgb, ${wmC} 62%, ${wmB})`;
    wm = document.createElement("div");
    wm.className = "png-wm";
    wm.style.cssText = `margin:12px ${-parseFloat(bcs.paddingRight) || 0}px ${-parseFloat(bcs.paddingBottom) || 0}px ${-parseFloat(bcs.paddingLeft) || 0}px;padding:0 0 16px;text-align:center;font-family:'Noto Sans SC',sans-serif;`;
    wm.innerHTML = `
      <span style="font-weight:900;font-size:15px;letter-spacing:.12em;color:${wmC}"><span style="font-family:Archivo,sans-serif;font-weight:400;font-size:20px;vertical-align:-2px">{</span> 由 琉璃 设计 <span style="font-family:Archivo,sans-serif;font-weight:400;font-size:20px;vertical-align:-2px">}</span></span>
      <span style="font-size:11px;letter-spacing:.14em;color:${wmA};margin-left:14px"><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${wmC};vertical-align:1px;margin-right:9px"></i>小红书 / 画加 <b style="color:${wmC}">@脆琉璃</b></span>`;
    wmBox.appendChild(wm);

    /* 网页上本就单行的文本 / 标签行，导出时字体度量略宽会被挤成两行——
       这正是「网页不换行、PNG 却换行」的根源（对话台词、标签、导语、所属大字、
       「关于 TA」标签行、DATA / CREDITS 资料值等都中过招）。逐节点按屏幕高度
       判定是否单行：
       · 单行文本叶子 / 对话 / 导语 / 标签 / 资料值 → 强制 nowrap 并放开写死宽度；
       · 单行的 flex-wrap 标签容器（.fms-tags2 / .fmn-tags）→ 强制
         flex-wrap:nowrap，避免最后一项连同「/」分隔符掉到第二行。
       本就多行的长文本 / 语气网格因高度超过一行不会命中此逻辑，按原样保留换行；
       资料值同理——屏幕上单行的才锁单行，屏幕上本就两行的长值不受影响，
       从根上避免了「单行值被挤成两行、第二行还压住下一栏」的重叠。 */
    for (const el of [card, ...card.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
      /* 判定「屏幕上是否单行」用内容高度（去掉上下内边距）：
         气泡、时代标签等带内边距的块，算上 padding 会被误判为多行而漏保护 */
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      if (el.getBoundingClientRect().height - padY > lh * 1.4) continue;
      if (el.matches(".fms-tags2, .fmn-tags")) {
        el.classList.add("png-nowrap-row"); marked.push(el);
      } else {
        const isLeaf = el.children.length === 0 && el.textContent.trim() !== "";
        /* 含多个子节点的单行组合块（名签＋台词的气泡、「—」＋时代名的标签、
           问答行、词条名等）也整块锁单行：只对子节点各自 nowrap 挡不住
           子节点之间的断行——字体嵌入失败回退时文字变宽，台词会掉到名签
           下一行、时代名被挤出深色块。 */
        const isTextRow = el.matches(".fv-turn p, .fmn-q.dlg .dl, .fms-line, .fmn-line, .fms-tag2, .fmn-tag, .tl-era, .bubble, .qa-row, .bc-title, .att-line, .wvm .e .k, .rmod-cap, .rmod-gate");
        /* 「冠绝古今…」两侧的「× × ×」由 .fa-side 的 ::before 渲染，不属于
           textContent，会漏过上面的叶子判定而在导出时被挤断——单独纳入。 */
        const isDecor = el.matches(".fa-side");
        if (isLeaf || isTextRow || isDecor) { el.classList.add("png-nowrap"); marked.push(el); }
      }
    }

    /* hideSel 的区域已隐藏，此处宽高即最终导出尺寸；编辑按钮等交互元素
       另由 filter 从克隆中兜底剔除 */
    const W = card.offsetWidth;
    const H = card.offsetHeight;

    const blob = await modernScreenshot.domToBlob(card, {
      type: "image/png",
      scale: 2,                 // 两倍分辨率
      backgroundColor: bg,      // null＝透明底（角色卡：图片边缘即卡片黑框）
      width: W,
      height: H,
      font: { preferredFormat: "woff2" },   // 网络字体统一嵌 woff2，降低嵌入失败概率
      filter: (n) => n.nodeType !== 1 || !n.matches(PNG_EXCLUDE),
      onCloneNode: (cloned) => {
        if (cloned.nodeType !== 1) return;
        cloned.style.margin = "0";
        cloned.style.height = "auto";   // 去掉导航后回归自适应，不留底部空白
        cloned.querySelectorAll(".png-nowrap").forEach((n) => {
          n.style.whiteSpace = "nowrap";
          n.style.width = "auto";
          n.style.maxWidth = "none";
          const turn = n.closest(".fv-turn");
          if (turn) turn.style.width = "auto";   // 放开写死宽度，保留 max-width 不越界
        });
        cloned.querySelectorAll(".png-nowrap-row").forEach((n) => {
          n.style.flexWrap = "nowrap";
          n.style.width = "auto";
          n.style.maxWidth = "none";
        });
        /* 靠 margin-left:auto 顶到行尾的元素（世界观页脚拼音大字 / 首屏档案
           编号、角色卡右上角等），克隆内联样式时 auto 会被固化成屏幕上的
           像素值——左端从此钉死；字体嵌入失败回退时文字变宽，右端就被推出
           图外（世界观详情页底部 RIYUETONGCUO 中过招）。克隆里还原为 auto，
           让 flex 重新贴右对齐，文字加宽时向左伸展、不越右界。 */
        cloned.querySelectorAll(".wvd-fn, .wvd-num, .wvd-cast-go, .fms-corner, .fms-colorset, .rmod-cap b, .rmod-gate .gval, .png-wm-r").forEach((n) => {
          /* 克隆内联样式里 margin-left 与 margin-inline-start 并存（同值像素），
             只改前者会被后者压回——两个都还原，并以 important 保证生效 */
          n.style.setProperty("margin-left", "auto", "important");
          n.style.setProperty("margin-inline-start", "auto", "important");
        });
      },
    });

    previewPNG(blob, filename);
  } catch (err) {
    uiNotice("生成 PNG 失败：" + (err && err.message ? err.message : err));
  } finally {
    if (wm) wm.remove();
    tightened.forEach(([el, prop, v]) => { el.style[prop] = v; });
    /* 逆序恢复：同一元素可能被 hideSel 与 PNG_EXCLUDE 先后隐藏两次，
       正序会把中途保存的 "none" 当原值写回 */
    for (let i = hidden.length - 1; i >= 0; i--) hidden[i][0].style.display = hidden[i][1];
    marked.forEach((el) => el.classList.remove("png-nowrap", "png-nowrap-row"));
    btn.disabled = false;
    btn.innerHTML = oldHTML;
  }
}

/* 角色卡 PNG：只截黑框主体（末尾角色切换导航不进图） */
function downloadCardPNG(btn) {
  const ch = charById(new URLSearchParams(location.search).get("id"));
  exportNodePNG(btn, {
    node: $(".fms, .fmn"),
    filename: `${(ch && ch.name) || "角色"}·角色卡.png`,
    bg: null,
    hideSel: ".fms-next, .fmn-next",
  });
}

/* 关系详情页 PNG：整页导出（顶部大标题区 / 返回链接 / 交互元素不进图） */
function downloadRelPNG(btn) {
  const ri = Math.max(0, DATA.relationships.findIndex((r) => r.id === new URLSearchParams(location.search).get("id")));
  const rel = DATA.relationships[ri];
  exportNodePNG(btn, {
    node: $("#rel"),
    filename: `${hashCore(rel && rel.hashtag) || "关系"}·关系档案.png`,
    bg: cssColor("--bg"),
    hideSel: ".hero-v2, .back-link",
  });
}

/* 世界观详情页 PNG：整页导出（编辑按钮 / 返回链接不进图） */
function downloadWvdPNG(btn) {
  const wid = new URLSearchParams(location.search).get("id");
  const w = DATA.worldviews.find((x) => String(x.no) === String(wid));
  exportNodePNG(btn, {
    node: $("#world .wvd") || $("#world"),
    filename: `${(w && w.title) || "世界观"}·世界观档案.png`,
    bg: cssColor("--bg"),
    hideSel: ".back-link",
  });
}

/* ==========================================================
   导出 TXT（角色卡 / 关系页 / 世界观页 → 纯文本档案）
   把当前页面的档案内容整理成可读的纯文本，先预览再下载 .txt。
   与 PNG 一样只导出内容本身（不含交互 / 装饰），便于复制、存档、投稿。
   ========================================================== */

/* 文本工具：纯中文分节标题、去掉空字段。
   排版规则：各分类内部不留空行，只有每个【】分节标题之前空一行分隔。 */
const txtHead = (cn) => `【${cn}】`;
const txtClean = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").trimEnd();
const txtHas = (s) => txtClean(s).trim() !== "";
function txtJoin(lines) {
  const flat = lines.join("\n").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of flat) {
    if (line.trim() === "") continue;
    if (/^【.*】$/.test(line.trim()) && out.length) out.push("");
    out.push(line);
  }
  return out.join("\n").trim() + "\n";
}

/* 角色卡 → 文本（纯中文「字段：内容」） */
function charToTxt(ch) {
  const L = [];
  L.push("姓名：" + (txtHas(ch.name) ? txtClean(ch.name) : ""));
  if (txtHas(ch.en)) L.push("英文名：" + txtClean(ch.en));
  if (txtHas(ch.mbti)) L.push("性格：" + txtClean(ch.mbti));
  if (txtHas(ch.alignment)) L.push("阵营：" + txtClean(ch.alignment));
  const tags = (ch.tags || []).map(txtClean).filter((t) => t.trim());
  if (tags.length) L.push("标签：" + tags.join(" / "));
  if (txtHas(ch.oneLine)) L.push("简介：" + txtClean(ch.oneLine));
  L.push("");

  const prof = Object.entries(ch.profile || {}).filter(([, v]) => txtHas(v));
  if (prof.length) {
    L.push(txtHead("档案"));
    prof.forEach(([k, v]) => L.push(`${txtClean(k)}：${txtClean(v)}`));
    L.push("");
  }

  const intro = (ch.intro || []).map(paraOf).filter((p) => txtHas(p.title) || txtHas(p.text));
  if (intro.length) {
    L.push(txtHead("人物志"));
    intro.forEach((p) => {
      if (txtHas(p.title)) L.push(`${txtClean(p.title)}：`);
      if (txtHas(p.text)) L.push(txtClean(p.text));
      L.push("");
    });
  }

  const quotes = ch.quotes || [];
  const solos = [];
  const dialogs = [];
  quotes.forEach((q) => {
    if (Array.isArray(q.dialog)) {
      const ds = q.dialog.filter((d) => txtHas(d.who) || txtHas(d.text));
      if (ds.length) dialogs.push(ds);
    } else if (txtHas(q.text)) {
      solos.push(txtClean(q.text));
    }
  });
  if (solos.length || dialogs.length) {
    L.push(txtHead("语录"));
    if (solos.length) {
      L.push("{单人}");
      solos.forEach((t) => L.push(`“${t}”`));
    }
    if (dialogs.length) {
      L.push("{双人}");
      dialogs.forEach((ds, di) => {
        L.push(`${di + 1}.`);
        ds.forEach((d) => L.push(`${txtHas(d.who) ? txtClean(d.who) + "：" : ""}${txtClean(d.text)}`));
      });
    }
    L.push("");
  }

  return txtJoin(L);
}

/* 关系页 → 文本（纯中文「字段：内容」） */
function relToTxt(rel) {
  const a = charById(rel.pair && rel.pair[0]);
  const b = charById(rel.pair && rel.pair[1]);
  const nm = (c, fb) => (c && txtHas(c.name) ? txtClean(c.name) : fb);
  const na = nm(a, "角色一"), nb = nm(b, "角色二");
  const L = [];
  L.push("关系名称：" + (txtHas(rel.title) ? txtClean(rel.title) : `${na} × ${nb}`));
  if (txtHas(rel.en)) L.push("英文名：" + txtClean(rel.en));
  if (txtHas(rel.hashtag)) L.push("话题：#" + txtClean(rel.hashtag).replace(/^#/, ""));
  const rtags = (rel.tags || []).map(txtClean).filter((t) => t.trim());
  if (rtags.length) L.push("标签：" + rtags.join(" / "));
  if (txtHas(rel.tagline)) L.push("题记：" + txtClean(rel.tagline));
  L.push("");

  const calls = rel.calls || {};
  const att = rel.attitude || {};
  const callLine = (c, name) => (c && txtHas(calls[c.id]) && calls[c.id] !== "—" ? `${name}称对方：${txtClean(calls[c.id])}` : "");
  const cl = [callLine(a, na), callLine(b, nb)].filter(Boolean);
  if (cl.length) { L.push(txtHead("称呼")); L.push(...cl); L.push(""); }

  const attBlock = (c, self, other) => {
    const o = att[c && c.id] || {};
    const s = txtHas(o.surface) && o.surface !== "—" ? txtClean(o.surface) : "";
    const i = txtHas(o.inner) && o.inner !== "—" ? txtClean(o.inner) : "";
    if (!s && !i) return [];
    const block = [`${self}→${other}：`];
    if (s) block.push(`表：${s}`);
    if (i) block.push(`里：${i}`);
    return block;
  };
  const ab = [attBlock(a, na, nb), attBlock(b, nb, na)].filter((x) => x.length);
  if (ab.length) {
    L.push(txtHead("对彼此的看法"));
    ab.forEach((block) => { L.push(...block, ""); });
  }

  const before = rel.before || {};
  const bl = [];
  if (a && txtHas(before[a.id])) bl.push(`遇到${nb}之前的${na}：`, txtClean(before[a.id]), "");
  if (b && txtHas(before[b.id])) bl.push(`遇到${na}之前的${nb}：`, txtClean(before[b.id]), "");
  if (bl.length) { L.push(txtHead("遇到彼此之前")); L.push(...bl); }

  const tl = (rel.timeline || []).filter((t) => txtHas(t.era) || txtHas(t.text) || (t.bubbles || []).some((x) => txtHas(x.text)));
  if (tl.length) {
    L.push(txtHead("时间线"));
    tl.forEach((t) => {
      if (txtHas(t.era)) L.push(`${txtClean(t.era)}：`);
      if (txtHas(t.text)) L.push(txtClean(t.text));
      (t.bubbles || []).filter((x) => txtHas(x.who) || txtHas(x.text)).forEach((x) =>
        L.push(`${txtHas(x.who) ? txtClean(x.who) + "：" : ""}${txtClean(x.text)}`));
      L.push("");
    });
  }

  const iv = (rel.interview || []).filter((qa) => txtHas(qa.q) || (qa.answers || []).some((x) => txtHas(x.text)));
  if (iv.length) {
    L.push(txtHead("采访间"));
    iv.forEach((qa) => {
      if (txtHas(qa.q)) L.push(`问：${txtClean(qa.q)}`);
      (qa.answers || []).filter((x) => txtHas(x.who) || txtHas(x.text)).forEach((x) =>
        L.push(`${txtHas(x.who) ? txtClean(x.who) + "：" : ""}${txtClean(x.text)}`));
      L.push("");
    });
  }

  (rel.custom || []).forEach((m) => {
    if (!(txtHas(m.title) || txtHas(m.text))) return;
    L.push(txtHead(txtHas(m.title) ? txtClean(m.title) : "附加条目"));
    if (txtHas(m.text)) L.push(txtClean(m.text));
    L.push("");
  });

  return txtJoin(L);
}

/* 世界观详情页 → 文本（纯中文「字段：内容」） */
function wvdToTxt(w) {
  const L = [];
  L.push("名称：" + (txtHas(w.title) ? txtClean(w.title) : ""));
  if (txtHas(w.type)) L.push("类型：" + txtClean(w.type));
  if (txtHas(w.subtitle)) L.push("副标题：" + txtClean(w.subtitle));
  const lead = txtHas(w.lead) ? txtClean(w.lead) : (w.desc && txtHas(w.desc[0]) ? txtClean(w.desc[0]) : "");
  if (lead) L.push("导语：" + lead);
  L.push("");

  const desc = (w.desc || []).map(txtClean).filter((d) => d.trim() && d !== lead);
  if (desc.length) {
    L.push(txtHead("概述"));
    desc.forEach((d) => { L.push(d); L.push(""); });
  }

  (w.sections || []).forEach((s) => {
    const ents = (s.entries || []).filter((e) => e && (txtHas(e.k) || txtHas(e.v)));
    if (!(txtHas(s.title) || txtHas(s.intro) || ents.length)) return;
    L.push(txtHead(txtHas(s.title) ? txtClean(s.title) : "板块"));
    if (txtHas(s.intro)) { L.push(txtClean(s.intro)); L.push(""); }
    ents.forEach((e) => {
      const warn = e.warn ? "⚠ " : "";
      L.push(`${warn}${txtClean(e.k)}${txtHas(e.v) ? "：" + txtClean(e.v) : ""}`);
    });
    L.push("");
  });

  const cast = (w.cast || []).map((c) => {
    const ch = charById(c.id);
    if (!ch) return "";
    const role = txtHas(c.role) ? txtClean(c.role) : txtClean(ch.mbti);
    return `${txtClean(ch.name) || ch.id}${role ? "（" + role + "）" : ""}`;
  }).filter(Boolean);
  if (cast.length) { L.push(txtHead("出场角色")); L.push(...cast); L.push(""); }

  if (txtHas(w.relation)) { L.push(txtHead("关系")); L.push(txtClean(w.relation)); L.push(""); }

  return txtJoin(L);
}

/* TXT 预览框：先看整理后的文本，可复制或下载 .txt */
function previewTXT(text, filename) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor";
  wrap.innerHTML = `
    <div class="ae-panel txtp-panel">
      <div class="pngp-head"><i class="fa-solid fa-file-lines"></i> TXT 预览<span class="pngp-name"></span></div>
      <div class="txtp-stage"><pre class="txtp-pre"></pre></div>
      <div class="ae-actions">
        <button type="button" class="ae-cancel">取消</button>
        <button type="button" class="ae-swap txtp-copy"><i class="fa-solid fa-copy"></i> 复制文本</button>
        <button type="button" class="ae-ok txtp-dl"><i class="fa-solid fa-download"></i> 下载 TXT</button>
      </div>
    </div>`;
  wrap.querySelector(".pngp-name").textContent = filename;
  wrap.querySelector(".txtp-pre").textContent = text;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector(".ae-cancel").addEventListener("click", close);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  const copyBtn = wrap.querySelector(".txtp-copy");
  copyBtn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      const old = copyBtn.innerHTML;
      copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制';
      setTimeout(() => { copyBtn.innerHTML = old; }, 1400);
    } catch (err) {
      uiNotice("复制失败，请手动选择文本复制。");
    }
  });

  wrap.querySelector(".txtp-dl").addEventListener("click", () => {
    /* UTF-8 BOM：让 Windows 记事本正确识别中文编码 */
    const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement("a");
    aEl.download = filename;
    aEl.href = url;
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    wrap.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
}

/* 角色卡 TXT */
function downloadCardTXT() {
  const ch = charById(new URLSearchParams(location.search).get("id"));
  if (!ch) return;
  previewTXT(charToTxt(ch), `${ch.name || "角色"}·人设档案.txt`);
}

/* 关系页 TXT */
function downloadRelTXT() {
  const ri = Math.max(0, DATA.relationships.findIndex((r) => r.id === new URLSearchParams(location.search).get("id")));
  const rel = DATA.relationships[ri];
  if (!rel) return;
  previewTXT(relToTxt(rel), `${hashCore(rel.hashtag) || rel.title || "关系"}·关系档案.txt`);
}

/* 世界观页 TXT */
function downloadWvdTXT() {
  const wid = new URLSearchParams(location.search).get("id");
  const w = DATA.worldviews.find((x) => String(x.no) === String(wid));
  if (!w) return;
  previewTXT(wvdToTxt(w), `${w.title || "世界观"}·世界观档案.txt`);
}

/* ---------- 导入 data.js ----------
   读取本地 data.js 文件（通常是之前「导出 data.js」得到的），
   解析出 SITE / CHARACTERS / RELATIONSHIPS / WORLDVIEWS，
   确认后覆盖当前浏览器中的全部数据。 */
function importDataJs() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".js,text/javascript,application/javascript";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let d;
      try {
        /* 在函数作用域内执行文件内容，取出四个数据常量（兼容手工编辑过的 data.js） */
        d = new Function(String(reader.result) + `
          ;return {
            site: typeof SITE === "undefined" ? null : SITE,
            characters: typeof CHARACTERS === "undefined" ? null : CHARACTERS,
            relationships: typeof RELATIONSHIPS === "undefined" ? null : RELATIONSHIPS,
            worldviews: typeof WORLDVIEWS === "undefined" ? null : WORLDVIEWS,
          };`)();
      } catch (err) {
        uiNotice("文件解析失败，请确认选择的是有效的 data.js。\n" + (err && err.message ? err.message : err));
        return;
      }
      if (!d || !d.site || !Array.isArray(d.characters) || !Array.isArray(d.relationships) || !Array.isArray(d.worldviews)) {
        uiNotice("这个文件不是有效的 data.js：缺少 SITE / CHARACTERS / RELATIONSHIPS / WORLDVIEWS 数据。");
        return;
      }
      uiConfirm(`确定用「${file.name}」覆盖当前的全部内容？\n站点文案、角色、关系、世界观都会被文件中的数据替换，此操作不可撤销。`, () => {
        DATA = { site: d.site, characters: d.characters, relationships: d.relationships, worldviews: d.worldviews, __v: DATA_VER };
        try {
          saveData();
        } catch (err) {
          uiNotice("内容过大，浏览器存储空间不足，导入失败。请压缩文件中的头像图片后重试。");
          DATA = loadData();
          renderAll();
          return;
        }
        renderAll();
        uiNotice("导入成功！页面内容已替换为文件中的数据。");
      });
    };
    reader.onerror = () => uiNotice("文件读取失败，请重试。");
    reader.readAsText(file, "utf-8");
  };
  input.click();
}

/* ---------- 导出 data.js ---------- */
function exportDataJs() {
  const body = `/* ==========================================================
   人设档案数据（由网站编辑模式导出）
   用这个文件替换仓库里的 js/data.js 即可让修改永久生效
   ========================================================== */

const SITE = ${JSON.stringify(DATA.site, null, 2)};

const CHARACTERS = ${JSON.stringify(DATA.characters, null, 2)};

const RELATIONSHIPS = ${JSON.stringify(DATA.relationships, null, 2)};

const WORLDVIEWS = ${JSON.stringify(DATA.worldviews, null, 2)};
`;
  const blob = new Blob([body], { type: "text/javascript;charset=utf-8" });
  const aEl = document.createElement("a");
  aEl.href = URL.createObjectURL(blob);
  aEl.download = "data.js";
  aEl.click();
  URL.revokeObjectURL(aEl.href);
}

/* ---------- 启动 ---------- */
function renderAll() {
  document.body.classList.toggle("editing", EDIT);
  renderNav();
  renderFooter();
  renderToolbar();
  if (PAGE === "home") renderHome();
  if (PAGE === "character") renderCharacter();
  if (PAGE === "relationship") renderRelationship();
  if (PAGE === "worldview") renderWorldview();
  renderPendant();
}

document.addEventListener("DOMContentLoaded", () => {
  PAGE = document.body.dataset.page;
  renderAll();
  /* 拉取线上数据：成功则以线上内容重渲染，否则维持本地 / 默认数据 */
  syncPull().then((changed) => {
    if (changed) renderAll();
    paintSyncPill();
  });
});
