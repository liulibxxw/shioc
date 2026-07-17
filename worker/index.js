/* ==========================================================
   人设档案馆 · Cloudflare Worker（静态资源 + 线上数据同步 API）

   路由：
   · GET  /api/status : 报告线上同步是否可用（KV 是否绑定 / 口令是否已设定）
   · GET  /api/verify : 校验请求头 X-Edit-Key 口令是否可用于保存
   · GET  /api/data   : 读取线上数据（所有访客加载页面时调用）
   · PUT  /api/data   : 保存数据到线上（需请求头 X-Edit-Key 口令）
   · 其余路径          : 交给静态资源（ASSETS）处理，与纯静态站行为一致

   保存鉴权（单口令）：
   · 首次带口令的保存会「设定」该口令（把它的 SHA-256 散列存入 KV），此后各设备须一致。
     无需在服务器配置任何密钥，直接在网页里输入一次即可。
     忘记 / 更换口令：删除 KV 中的 auth-hash 条目即可重新设定。

   绑定（见 wrangler.jsonc / 部署说明）：
   · env.OC_DATA  KV 命名空间，保存唯一一份站点数据与口令散列
   · env.ASSETS   静态资源绑定
   ========================================================== */

const DATA_KEY = "site-data";
const AUTH_KEY = "auth-hash";        // 首次设定的口令散列
const MAX_BYTES = 24 * 1024 * 1024;  // KV 单值上限 25MB，留出余量

/* SHA-256 十六进制（把口令散列后存入 KV，不落明文） */
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("oc::" + s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* 恒定时间比较，避免通过响应耗时旁路猜测口令散列 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function validShape(d) {
  return !!(
    d && typeof d === "object" &&
    d.site && typeof d.site === "object" &&
    Array.isArray(d.characters) &&
    Array.isArray(d.relationships) &&
    Array.isArray(d.worldviews)
  );
}

async function handleData(request, env) {
  if (!env.OC_DATA) {
    return json({ enabled: false, error: "KV 未绑定（OC_DATA）" }, 501);
  }

  if (request.method === "GET") {
    const raw = await env.OC_DATA.get(DATA_KEY);
    if (!raw) return json({ enabled: true, data: null, rev: 0, updatedAt: null });
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    if (!rec || !validShape(rec.data)) return json({ enabled: true, data: null, rev: 0, updatedAt: null });
    return json({ enabled: true, data: rec.data, rev: rec.rev || 0, updatedAt: rec.updatedAt || null });
  }

  if (request.method === "PUT") {
    const provided = request.headers.get("x-edit-key") || "";
    if (!provided) return json({ error: "缺少同步口令" }, 401);
    /* 口令校验：已设定则须一致；未设定则本次为首次设定，
       其散列留到数据校验通过、真正保存时再一并落定，避免无效请求把口令占用掉 */
    const h = await sha256hex(provided);
    const stored = await env.OC_DATA.get(AUTH_KEY);
    let claimHash = null;
    if (stored) {
      if (!safeEqual(stored, h)) return json({ error: "同步口令不正确" }, 401);
    } else {
      claimHash = h;
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "请求体不是有效 JSON" }, 400); }
    const data = body && body.data;
    if (!validShape(data)) return json({ error: "数据结构无效（缺少 site / characters / relationships / worldviews）" }, 400);

    /* 读旧版本号并自增，便于日后做并发检测；此处仍为「后写覆盖」 */
    let prevRev = 0;
    const prevRaw = await env.OC_DATA.get(DATA_KEY);
    if (prevRaw) { try { prevRev = JSON.parse(prevRaw).rev || 0; } catch (e) { /* ignore */ } }

    const rec = {
      data: { site: data.site, characters: data.characters, relationships: data.relationships, worldviews: data.worldviews },
      rev: prevRev + 1,
      updatedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(rec);
    if (serialized.length > MAX_BYTES) return json({ error: "数据过大，请压缩头像图片后重试" }, 413);

    if (claimHash) await env.OC_DATA.put(AUTH_KEY, claimHash);   // 口令随首次成功保存一并设定
    await env.OC_DATA.put(DATA_KEY, serialized);
    return json({ ok: true, rev: rec.rev, updatedAt: rec.updatedAt });
  }

  return json({ error: "不支持的方法" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      /* enabled / writable：KV 已绑定即可读写；claimed：口令是否已设定 */
      const claimed = env.OC_DATA ? !!(await env.OC_DATA.get(AUTH_KEY)) : false;
      return json({ enabled: !!env.OC_DATA, writable: !!env.OC_DATA, claimed });
    }
    if (url.pathname === "/api/verify") {
      /* 校验口令是否可用于保存：valid=true 表示可进入编辑并同步
         （未设定过口令时，任何非空口令都 valid，作为首次设定） */
      if (!env.OC_DATA) return json({ enabled: false });
      const provided = request.headers.get("x-edit-key") || "";
      const stored = await env.OC_DATA.get(AUTH_KEY);
      if (!stored) return json({ enabled: true, claimed: false, valid: !!provided });
      if (!provided) return json({ enabled: true, claimed: true, valid: false });
      const h = await sha256hex(provided);
      return json({ enabled: true, claimed: true, valid: safeEqual(stored, h) });
    }
    if (url.pathname === "/api/data") {
      return handleData(request, env);
    }

    /* 其余路径交给静态资源；未绑定 ASSETS 时兜底 404 */
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
