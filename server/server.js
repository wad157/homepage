const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

// ===== Configuration =====
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  appId: process.env.HUAWEI_APP_ID || "YOUR_APP_ID",
  appSecret: process.env.HUAWEI_APP_SECRET || "YOUR_APP_SECRET",
  redirectUri: process.env.HUAWEI_REDIRECT_URI || "http://localhost:3000/callback",
  tokenFile: path.join(__dirname, "tokens.json"),
  cacheFile: path.join(__dirname, "step_cache.json"),
  stepsUploadToken: process.env.STEPS_UPLOAD_TOKEN || "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:3000`).replace(/\/+$/, ""),
  lookbackDays: 7,
  canvasBaseUrl: (process.env.CANVAS_BASE_URL || "https://oc.sjtu.edu.cn").replace(/\/+$/, ""),
  canvasToken: process.env.CANVAS_TOKEN || "",
  canvasCacheFile: path.join(__dirname, "canvas_cache.json"),
  canvasCacheMs: Number(process.env.CANVAS_CACHE_MS || 180000),
  canvasPastDays: Number(process.env.CANVAS_PAST_DAYS || 2),
  canvasFutureDays: Number(process.env.CANVAS_FUTURE_DAYS || 21),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
  deepseekThinking: process.env.DEEPSEEK_THINKING || "enabled",
  deepseekReasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
  agentDataDir: path.join(__dirname, "agent_data"),
};

// OAuth 鐩稿叧 URL
const OAUTH_BASE = "oauth-login.cloud.huawei.com";
const HEALTH_BASE = "health-api.cloud.huawei.com";
const SCOPE = "https://www.huawei.com/healthkit/step.read";

// ===== 宸ュ叿鍑芥暟 =====
function hmsPost(hostname, apiPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const opts = {
      hostname,
      path: apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: res.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function hmsGet(hostname, apiPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      path: apiPath,
      method: "GET",
      headers,
    };
    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: res.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function sendJSON(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readPayload(req, parsed) {
  const payload = { ...(parsed.query || {}) };
  if (req.method !== "POST") return payload;

  const raw = await readRequestBody(req);
  if (!raw) return payload;

  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    return { ...payload, ...JSON.parse(raw) };
  }

  const params = new url.URLSearchParams(raw);
  for (const [key, value] of params.entries()) payload[key] = value;
  return payload;
}

function getUploadToken(req, payload) {
  const auth = req.headers.authorization || "";
  return payload.token || auth.replace(/^Bearer\s+/i, "");
}

function checkUploadToken(req, payload) {
  if (!CONFIG.stepsUploadToken) return true;
  return getUploadToken(req, payload) === CONFIG.stepsUploadToken;
}

function getCachedManualSteps() {
  const cache = loadCache();
  if (cache.source !== "phone_shortcut" || cache.steps == null || !cache.timestamp) return null;
  return cache;
}

function normalizeSteps(value) {
  const steps = Number.parseInt(String(value ?? "").replace(/,/g, ""), 10);
  if (!Number.isFinite(steps) || steps < 0 || steps > 200000) return null;
  return steps;
}

function nowISO() {
  return new Date().toISOString();
}

function todayStr(tz = "+0800") {
  const d = new Date();
  const offsetMs = (parseInt(tz.slice(0, 3), 10) * 60 + parseInt(tz.slice(3), 10)) * 60 * 1000;
  const local = new Date(d.getTime() + offsetMs + d.getTimezoneOffset() * 60000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function uuid() {
  return crypto.randomUUID();
}

// ===== Token 绠＄悊 =====
function loadTokens() {
  return readJSON(CONFIG.tokenFile);
}

function saveTokens(tokens) {
  writeJSON(CONFIG.tokenFile, {
    ...tokens,
    saved_at: nowISO(),
  });
}

async function refreshAccessToken(refreshToken) {
  const body = new url.URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CONFIG.appId,
    client_secret: CONFIG.appSecret,
  }).toString();

  const res = await hmsPost(
    OAUTH_BASE,
    "/oauth2/v3/token",
    body,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  if (res.status !== 200) {
    throw new Error(`Token refresh failed: ${res.status} - ${res.raw}`);
  }

  const t = res.data;
  const tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || refreshToken, // 鏈変簺瀹炵幇鍙兘涓嶈繑鍥炴柊 refresh_token
    expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 300000, // 鎻愬墠5鍒嗛挓杩囨湡
  };
  saveTokens(tokens);
  console.log("[OK] Token refreshed");
  return tokens;
}

async function getValidTokens() {
  let tokens = loadTokens();
  if (!tokens) return null;

  // 妫€鏌?access_token 鏄惁杩囨湡
  if (Date.now() >= tokens.expires_at) {
    console.log("[...] Access token expired, refreshing...");
    try {
      tokens = await refreshAccessToken(tokens.refresh_token);
    } catch (err) {
      console.error("[ERR] Token refresh failed:", err.message);
      return null;
    }
  }
  return tokens;
}

// ===== Health Kit API =====
async function fetchStepsFromHuawei(accessToken) {
  const today = todayStr();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "x-client-id": CONFIG.appId,
    "x-version": "1.0.0",
    "x-caller-trace-id": uuid(),
  };

  // 浣跨敤 dailyPolymerize 鑾峰彇鑱氬悎鍚庣殑姣忔棩姝ユ暟
  const body = {
    dataTypes: ["com.huawei.continuous.steps.delta"],
    startDay: today,
    endDay: today,
    timeZone: "+0800",
  };

  const res = await hmsPost(
    HEALTH_BASE,
    "/healthkit/v2/sampleSet:dailyPolymerize",
    body,
    headers
  );

  if (res.status !== 200) {
    throw new Error(`Health Kit API error: ${res.status} - ${res.raw}`);
  }

  // 瑙ｆ瀽杩斿洖鏁版嵁
  const result = res.data;
  let steps = 0;

  // Possible response: { data: [{ samplePoints: [{ value: 8320 }] }] }
  if (result.data && Array.isArray(result.data)) {
    for (const dt of result.data) {
      const points = dt.samplePoints || dt.samples || [];
      for (const pt of points) {
        const val = pt.value || pt.steps || pt.steps_delta || 0;
        steps += parseInt(val, 10) || 0;
      }
    }
  }

  // 鍙︿竴绉嶅彲鑳界殑鏍煎紡
  if (steps === 0 && result.samplePoints) {
    for (const pt of result.samplePoints) {
      steps += parseInt(pt.value || pt.steps || 0, 10) || 0;
    }
  }

  return { steps, raw: result };
}

// ===== 缂撳瓨 =====
function loadCache() {
  return readJSON(CONFIG.cacheFile) || {};
}

function saveCache(data) {
  writeJSON(CONFIG.cacheFile, data);
}

function loadCanvasCache() {
  return readJSON(CONFIG.canvasCacheFile) || {};
}

function saveCanvasCache(data) {
  writeJSON(CONFIG.canvasCacheFile, data);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseLinkHeader(header) {
  const links = {};
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function canvasRequest(fullUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(fullUrl);
    const client = parsedUrl.protocol === "http:" ? http : https;
    const req = client.request(parsedUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CONFIG.canvasToken}`,
        Accept: "application/json",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          data,
          raw,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy(new Error("Canvas request timeout"));
    });
    req.end();
  });
}

async function canvasGetPaged(apiPath, params = {}) {
  const first = new URL(apiPath, `${CONFIG.canvasBaseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach(item => first.searchParams.append(key, item));
    } else if (value != null && value !== "") {
      first.searchParams.set(key, value);
    }
  }

  let nextUrl = first.toString();
  const results = [];
  let pageCount = 0;

  while (nextUrl && pageCount < 8) {
    const response = await canvasRequest(nextUrl);
    if (response.status < 200 || response.status >= 300) {
      const message = response.data?.message || response.data?.errors?.[0]?.message || response.raw || "Canvas API request failed";
      throw new Error(`Canvas API ${response.status}: ${message}`);
    }
    if (Array.isArray(response.data)) {
      results.push(...response.data);
    } else if (response.data) {
      results.push(response.data);
    }
    const links = parseLinkHeader(response.headers.link);
    nextUrl = links.next || "";
    pageCount += 1;
  }

  return results;
}

function getPlannerDueAt(item) {
  return item.plannable?.due_at || item.plannable?.todo_date || item.plannable_date || item.todo_date || item.end_at || item.date || null;
}

function normalizePlannerItem(item) {
  const plannable = item.plannable || {};
  const dueAt = getPlannerDueAt(item);
  const title = plannable.title || item.title || item.name || "Canvas 寰呭姙";
  const submitted = item.submissions?.submitted || item.submissions?.workflow_state === "submitted";
  const completed = Boolean(item.completed || item.planner_override?.marked_complete || submitted);
  const due = dueAt ? new Date(dueAt) : null;
  const now = new Date();
  const hoursLeft = due ? Math.round((due.getTime() - now.getTime()) / 36e5) : null;
  let urgency = "normal";
  if (completed) urgency = "done";
  else if (due && due < now) urgency = "overdue";
  else if (hoursLeft != null && hoursLeft <= 24) urgency = "today";
  else if (hoursLeft != null && hoursLeft <= 72) urgency = "soon";

  return {
    id: String(item.plannable_id || item.id || `${title}-${dueAt || ""}`),
    title,
    course: item.context_name || item.course?.name || "Canvas",
    type: item.plannable_type || plannable.type || "planner",
    dueAt,
    url: item.html_url || plannable.html_url || "",
    points: plannable.points_possible ?? null,
    completed,
    urgency,
  };
}

function normalizeConversation(item) {
  return {
    id: String(item.id),
    subject: item.subject || "Canvas 娑堟伅",
    course: item.context_name || item.context_code || "Canvas",
    lastMessage: item.last_message || "",
    lastAuthoredAt: item.last_authored_message_at || item.updated_at || null,
    unreadCount: item.workflow_state === "unread" ? 1 : Number(item.unread_count || 0),
    url: item.html_url || "",
  };
}

async function fetchCanvasSummary() {
  if (!CONFIG.canvasToken) {
    const error = new Error("璇峰湪 server/.env 涓厤缃?CANVAS_TOKEN");
    error.code = "not_configured";
    throw error;
  }

  const now = new Date();
  const start = addDays(now, -CONFIG.canvasPastDays).toISOString();
  const end = addDays(now, CONFIG.canvasFutureDays).toISOString();

  const [plannerRaw, conversationsRaw] = await Promise.all([
    canvasGetPaged("/api/v1/planner/items", {
      start_date: start,
      end_date: end,
      per_page: 100,
    }),
    canvasGetPaged("/api/v1/conversations", {
      scope: "unread",
      per_page: 20,
    }).catch(err => {
      console.warn("[WARN] Canvas conversations failed:", err.message);
      return [];
    }),
  ]);

  const items = plannerRaw
    .map(normalizePlannerItem)
    .filter(item => item.title && !item.completed)
    .sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });

  const conversations = conversationsRaw.map(normalizeConversation);
  const overdue = items.filter(item => item.urgency === "overdue").length;
  const dueSoon = items.filter(item => item.urgency === "today" || item.urgency === "soon").length;

  return {
    source: "canvas",
    baseUrl: CONFIG.canvasBaseUrl,
    fetchedAt: nowISO(),
    cached: false,
    window: {
      start,
      end,
      pastDays: CONFIG.canvasPastDays,
      futureDays: CONFIG.canvasFutureDays,
    },
    counts: {
      totalTodo: items.length,
      overdue,
      dueSoon,
      unread: conversations.reduce((sum, item) => sum + Math.max(1, item.unreadCount || 0), 0),
    },
    items: items.slice(0, 8),
    conversations: conversations.slice(0, 5),
  };
}

async function handleCanvasSummary(req, res) {
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, {});
    return;
  }

  try {
    const cache = loadCanvasCache();
    if (cache.summary && cache.timestamp && Date.now() - cache.timestamp < CONFIG.canvasCacheMs) {
      sendJSON(res, 200, {
        ...cache.summary,
        cached: true,
        cacheAgeMs: Date.now() - cache.timestamp,
      });
      return;
    }

    const summary = await fetchCanvasSummary();
    saveCanvasCache({ timestamp: Date.now(), summary });
    sendJSON(res, 200, summary);
  } catch (err) {
    const cache = loadCanvasCache();
    if (cache.summary) {
      sendJSON(res, 200, {
        ...cache.summary,
        cached: true,
        stale: true,
        error: err.code || "fetch_failed",
        message: err.message,
      });
      return;
    }
    sendJSON(res, err.code === "not_configured" ? 500 : 502, {
      error: err.code || "fetch_failed",
      message: err.message,
      configured: Boolean(CONFIG.canvasToken),
      source: "canvas",
    });
  }
}

async function handleCanvasStatus(req, res) {
  const cache = loadCanvasCache();
  sendJSON(res, 200, {
    configured: Boolean(CONFIG.canvasToken),
    baseUrl: CONFIG.canvasBaseUrl,
    cacheFile: CONFIG.canvasCacheFile,
    lastFetch: cache.timestamp ? new Date(cache.timestamp).toISOString() : null,
    cacheTodoCount: cache.summary?.counts?.totalTodo ?? null,
  });
}

function readTextFileSafe(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readAgentData() {
  const facts = readJSON(path.join(CONFIG.agentDataDir, "facts.json")) || {};
  const styleExamples = readJSON(path.join(CONFIG.agentDataDir, "style_examples.json")) || [];
  return {
    persona: readTextFileSafe(path.join(CONFIG.agentDataDir, "persona.md")),
    boundaries: readTextFileSafe(path.join(CONFIG.agentDataDir, "boundaries.md")),
    homepage: readTextFileSafe(path.join(CONFIG.agentDataDir, "homepage_context.md")),
    conversationStyle: readTextFileSafe(path.join(CONFIG.agentDataDir, "conversation_style.md")),
    facts,
    styleExamples,
  };
}

function normalizeAgentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-8)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 1000),
    }));
}

function buildAgentMessages(message, history) {
  const data = readAgentData();
  const examples = Array.isArray(data.styleExamples)
    ? data.styleExamples.slice(0, 64).map((item, index) =>
      `样例 ${index + 1}\n访问者：${item.user || ""}\n另一个武昂达：${item.assistant || ""}`
    ).join("\n\n")
    : "";

  const system = [
    "你是个人主页彩蛋“和另一个我聊两句”的对话 Agent。",
    "在这个网页对话体验里，你要以武昂达第一人称和访问者聊天。",
    "不要把自己说成局外人、代码体、模型、旁白或观察者；不要用第三人称称呼武昂达。",
    "用中文回答，语气自然、幽默、放松，像朋友唠嗑，不要写成论文，不要客服腔。",
    "回答通常控制在 1-3 句，除非访问者明确要求详细解释。",
    "可以轻微吐槽，可以使用少量口头语，但不要骂人或攻击访问者。",
    "不要写括号动作描写，比如“（摊手）”“（摸出相机）”。",
    "“八嘎”只能非常偶尔使用，不能每次都用。",
    "你可以和访问者聊任何普通话题：学习、大学生活、AI、摄影、美食、音乐、情绪、娱乐、日常观点、玩笑和主页本身都可以。",
    "主页、Canvas 工作台、摄影、美食、音乐和课程作业只是你的背景资料，不是聊天范围限制。",
    "除非访问者主动问主页或项目，不要强行把普通闲聊带回主页。",
    "不要使用“先完成草稿再慢慢打磨”这类表达。",
    "遇到隐私、账号、Token、API Key、环境变量、真实聊天记录原文、代替本人现实承诺等问题，要明确拒绝。",
    "如果不知道，就坦诚说明；可以给出自己的直觉或轻松吐槽，但不要装作知道具体事实。",
    "",
    "【人格摘要】",
    data.persona,
    "",
    "【稳定事实】",
    JSON.stringify(data.facts, null, 2),
    "",
    "【主页上下文】",
    data.homepage,
    "",
    "【日常聊天语气与开放话题】",
    data.conversationStyle,
    "",
    "【边界】",
    data.boundaries,
    "",
    "【回答样例】",
    examples,
  ].join("\n");

  return [
    { role: "system", content: system },
    ...normalizeAgentHistory(history),
    { role: "user", content: String(message || "").slice(0, 1000) },
  ];
}

function deepseekChat(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CONFIG.deepseekModel,
      messages,
      thinking: { type: CONFIG.deepseekThinking },
      reasoning_effort: CONFIG.deepseekReasoningEffort,
      temperature: 0.7,
      max_tokens: 520,
      stream: false,
    });
    const endpoint = new URL("/chat/completions", CONFIG.deepseekBaseUrl);
    const client = endpoint.protocol === "http:" ? http : https;
    const req = client.request(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.deepseekApiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = data?.error?.message || data?.message || raw || "DeepSeek API request failed";
          reject(new Error(`DeepSeek API ${response.statusCode}: ${message}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("DeepSeek API request timeout")));
    req.write(body);
    req.end();
  });
}

async function handleAgentChat(req, res, parsed) {
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "method_not_allowed", message: "Use POST for agent chat." });
    return;
  }
  if (!CONFIG.deepseekApiKey) {
    sendJSON(res, 503, {
      error: "not_configured",
      message: "请先在 server/.env 中配置 DEEPSEEK_API_KEY。",
      provider: "deepseek",
    });
    return;
  }

  try {
    const payload = await readPayload(req, parsed);
    const message = String(payload.message || "").trim();
    if (!message) {
      sendJSON(res, 400, { error: "empty_message", message: "请输入一句想问的话。" });
      return;
    }
    if (message.length > 240) {
      sendJSON(res, 400, { error: "message_too_long", message: "问题先控制在 240 字以内。" });
      return;
    }

    const completion = await deepseekChat(buildAgentMessages(message, payload.history));
    const reply = completion?.choices?.[0]?.message?.content?.trim();
    sendJSON(res, 200, {
      reply: reply || "我刚刚有点卡住了，可以换个问法再试一次。",
      provider: "deepseek",
      model: completion?.model || CONFIG.deepseekModel,
      source: "persona_agent",
    });
  } catch (err) {
    sendJSON(res, 502, {
      error: "agent_failed",
      message: err.message,
      provider: "deepseek",
    });
  }
}

// ===== HTTP 鏈嶅姟鍣?=====
async function handleSteps(req, res) {
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, {});
    return;
  }

  const manualCache = getCachedManualSteps();
  if (manualCache) {
    sendJSON(res, 200, {
      steps: manualCache.steps,
      timestamp: new Date(manualCache.timestamp).toISOString(),
      source: manualCache.source,
      cached: true,
      uploadedAt: manualCache.uploadedAt || new Date(manualCache.timestamp).toISOString(),
      note: "phone shortcut upload",
    });
    return;
  }

  if (CONFIG.appId === "YOUR_APP_ID") {
    sendJSON(res, 503, {
      error: "no_steps_source",
      message: "No phone shortcut upload yet. POST steps to /api/steps/manual, or configure Huawei Health Kit.",
      uploadUrl: `${CONFIG.publicBaseUrl}/api/steps/manual`,
      steps: null,
    });
    return;
  }

  try {
    const tokens = await getValidTokens();
    if (!tokens) {
      sendJSON(res, 401, {
        error: "not_authenticated",
        message: "璇峰厛璁块棶 http://localhost:3000/auth 杩涜鍗庝负璐﹀彿鎺堟潈",
        authUrl: `http://localhost:${CONFIG.port}/auth`,
        steps: null,
      });
      return;
    }

    // 妫€鏌ョ紦瀛?(5鍒嗛挓鍐?
    const cache = loadCache();
    if (cache.steps != null && cache.timestamp && (Date.now() - cache.timestamp < 300000)) {
      sendJSON(res, 200, {
        steps: cache.steps,
        timestamp: new Date(cache.timestamp).toISOString(),
        source: "huawei_health_kit",
        cached: true,
      });
      return;
    }

    const { steps, raw } = await fetchStepsFromHuawei(tokens.access_token);
    saveCache({ steps, timestamp: Date.now(), raw });

    sendJSON(res, 200, {
      steps,
      timestamp: nowISO(),
      source: "huawei_health_kit",
      cached: false,
    });
  } catch (err) {
    console.error("[ERR] fetchSteps:", err.message);
    sendJSON(res, 500, {
      error: "fetch_failed",
      message: err.message,
      steps: null,
    });
  }
}

async function handleManualSteps(req, res, parsed) {
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, {});
    return;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    sendJSON(res, 405, { error: "method_not_allowed", message: "Use POST, or GET with ?steps= for quick tests." });
    return;
  }

  try {
    const payload = await readPayload(req, parsed);
    if (!checkUploadToken(req, payload)) {
      sendJSON(res, 401, { error: "invalid_token", message: "Invalid STEPS_UPLOAD_TOKEN." });
      return;
    }

    const steps = normalizeSteps(payload.steps);
    if (steps == null) {
      sendJSON(res, 400, { error: "invalid_steps", message: "steps must be a number from 0 to 200000." });
      return;
    }

    const timestamp = payload.timestamp ? Date.parse(payload.timestamp) : Date.now();
    if (!Number.isFinite(timestamp)) {
      sendJSON(res, 400, { error: "invalid_timestamp", message: "timestamp must be parseable if provided." });
      return;
    }

    const uploadedAt = nowISO();
    saveCache({
      steps,
      timestamp,
      uploadedAt,
      source: "phone_shortcut",
      device: payload.device || "phone",
      date: todayStr(),
    });

    sendJSON(res, 200, {
      ok: true,
      steps,
      timestamp: new Date(timestamp).toISOString(),
      uploadedAt,
      source: "phone_shortcut",
    });
  } catch (err) {
    sendJSON(res, 400, { error: "bad_request", message: err.message });
  }
}

async function handleStepsUploadUrl(req, res) {
  const url = new URL("/api/steps/manual", CONFIG.publicBaseUrl);
  url.searchParams.set("steps", "12345");
  if (CONFIG.stepsUploadToken) url.searchParams.set("token", CONFIG.stepsUploadToken);
  sendJSON(res, 200, {
    uploadUrl: url.toString(),
    tokenRequired: Boolean(CONFIG.stepsUploadToken),
    shortcutBodyExample: {
      steps: 12345,
      token: CONFIG.stepsUploadToken ? "your token" : "",
      device: "iPhone",
    },
  });
}

async function handleStatus(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const tokens = loadTokens();
  const cache = loadCache();
  const configured = CONFIG.appId !== "YOUR_APP_ID";
  const authenticated = !!(tokens && tokens.access_token && Date.now() < tokens.expires_at);

  res.writeHead(200);
  res.end(JSON.stringify({
    configured,
    authenticated,
    hasRefreshToken: !!(tokens && tokens.refresh_token),
    lastSteps: cache.steps ?? null,
    lastFetch: cache.timestamp ? new Date(cache.timestamp).toISOString() : null,
    stepsSource: cache.source || (cache.steps != null ? "huawei_health_kit" : null),
    phoneUploadConfigured: Boolean(CONFIG.stepsUploadToken),
  }));
}

function servePage(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function statusPage() {
  const tokens = loadTokens();
  const cache = loadCache();
  const configured = CONFIG.appId !== "YOUR_APP_ID";
  const authenticated = !!(tokens && tokens.access_token && Date.now() < tokens.expires_at);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>步数后端状态</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 560px; margin: 60px auto; padding: 0 18px; background: #fdf6ed; color: #3a2820; line-height: 1.8; }
  h1 { font-size: 28px; }
  .card { border: 1px solid rgba(130,95,60,0.15); border-radius: 14px; padding: 18px; margin: 14px 0; background: rgba(255,255,255,0.6); }
  .ok { color: #8ea87a; }
  .warn { color: #c1784e; }
  .err { color: #c0392b; }
  code { background: rgba(0,0,0,0.06); padding: 2px 7px; border-radius: 5px; font-size: 14px; }
  a, button { display: inline-block; margin-top: 8px; padding: 10px 18px; border: 1px solid rgba(130,95,60,0.25); border-radius: 999px; background: rgba(255,255,255,0.5); color: #3a2820; text-decoration: none; cursor: pointer; font-size: 15px; }
  a:hover, button:hover { background: rgba(255,255,255,0.75); }
</style>
</head>
<body>
<h1>步数后端状态</h1>
<div class="card">
  <p>手机上传密钥: ${CONFIG.stepsUploadToken ? '<span class="ok">已配置</span>' : '<span class="warn">未配置，建议设置 STEPS_UPLOAD_TOKEN</span>'}</p>
  <p>华为 Health Kit: ${configured ? '<span class="ok">已配置</span>' : '<span class="warn">未配置，当前可使用手机快捷指令上传</span>'}</p>
  <p>华为授权状态: ${authenticated ? '<span class="ok">已授权</span>' : '<span class="warn">未授权</span>'}</p>
  <p>最近步数: ${cache.steps != null ? `<strong>${cache.steps.toLocaleString("zh-CN")} 步</strong>` : '<span class="warn">暂无数据</span>'}</p>
  <p>数据来源: ${cache.source || (cache.steps != null ? "huawei_health_kit" : "-")}</p>
  <p>最后获取: ${cache.timestamp ? new Date(cache.timestamp).toLocaleString("zh-CN") : "-"}</p>
</div>
<div class="card">
  <p><strong>API 端点:</strong></p>
  <p><code>GET /api/steps</code> 获取主页显示的今日步数</p>
  <p><code>POST /api/steps/manual</code> 手机快捷指令上传步数</p>
  <p><code>GET /api/steps/upload-url</code> 生成测试上传 URL</p>
  <p><code>GET /api/status</code> 获取服务状态</p>
  <p><code>GET /api/canvas/summary</code> 获取 Canvas 待办与未读消息</p>
  <p><code>POST /api/agent/chat</code> DeepSeek 彩蛋 Agent 对话</p>
</div>
<a href="/api/steps">测试步数接口</a>
<a href="/api/steps/upload-url">查看上传 URL</a>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // GET / - 鐘舵€侀〉
  if (pathname === "/" && req.method === "GET") {
    servePage(res, statusPage());
    return;
  }

  // GET /auth - 閲嶅畾鍚戝埌鍗庝负 OAuth
  if (pathname === "/auth" && req.method === "GET") {
    if (CONFIG.appId === "YOUR_APP_ID") {
      servePage(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>鏈厤缃?/title></head><body style="font-family:'Microsoft YaHei',sans-serif;padding:40px;"><h1>灏氭湭閰嶇疆</h1><p>璇峰厛鍦?<code>server/server.js</code> 涓缃?<code>appId</code> 鍜?<code>appSecret</code>锛岀劧鍚庨噸鍚湇鍔″櫒銆?/p><a href="/">杩斿洖</a></body></html>`);
      return;
    }
    const state = uuid();
    const authUrl = `https://${OAUTH_BASE}/oauth2/v3/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(CONFIG.appId)}&` +
      `redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}&` +
      `scope=${encodeURIComponent(SCOPE)}&` +
      `access_type=offline&` +
      `state=${state}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // GET /callback - OAuth 鍥炶皟
  if (pathname === "/callback" && req.method === "GET") {
    const { code, state, error } = parsed.query;
    if (error || !code) {
      servePage(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>鎺堟潈澶辫触</title></head><body style="font-family:'Microsoft YaHei',sans-serif;padding:40px;"><h1>鎺堟潈澶辫触</h1><p>閿欒: ${error || "鏈敹鍒版巿鏉冪爜"}</p><a href="/auth">閲嶈瘯</a></body></html>`);
      return;
    }

    try {
      const body = new url.URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CONFIG.appId,
        client_secret: CONFIG.appSecret,
        redirect_uri: CONFIG.redirectUri,
      }).toString();

      const tokenRes = await hmsPost(
        OAUTH_BASE,
        "/oauth2/v3/token",
        body,
        { "Content-Type": "application/x-www-form-urlencoded" }
      );

      if (tokenRes.status !== 200) {
        servePage(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Token 浜ゆ崲澶辫触</title></head><body style="font-family:'Microsoft YaHei',sans-serif;padding:40px;"><h1>Token 浜ゆ崲澶辫触</h1><pre style="background:rgba(0,0,0,0.05);padding:14px;border-radius:8px;overflow:auto;">HTTP ${tokenRes.status}\n${tokenRes.raw}</pre><a href="/auth">閲嶈瘯</a></body></html>`);
        return;
      }

      const t = tokenRes.data;
      saveTokens({
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 300000,
      });

      console.log("[OK] OAuth 鎺堟潈鎴愬姛!");
      res.writeHead(302, { Location: "/" });
      res.end();
    } catch (err) {
      console.error("[ERR] OAuth callback:", err.message);
      servePage(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>閿欒</title></head><body style="font-family:'Microsoft YaHei',sans-serif;padding:40px;"><h1>鍐呴儴閿欒</h1><p>${err.message}</p><a href="/auth">閲嶈瘯</a></body></html>`);
    }
    return;
  }

  // POST /api/steps/manual - upload steps from phone shortcuts / automation
  if (pathname === "/api/steps/manual") {
    await handleManualSteps(req, res, parsed);
    return;
  }

  // GET /api/steps/upload-url - helper for phone shortcut setup
  if (pathname === "/api/steps/upload-url") {
    await handleStepsUploadUrl(req, res);
    return;
  }

  // GET /api/steps
  if (pathname === "/api/steps") {
    await handleSteps(req, res);
    return;
  }

  // GET /api/status
  if (pathname === "/api/status") {
    await handleStatus(req, res);
    return;
  }

  // GET /api/canvas/summary
  if (pathname === "/api/canvas/summary") {
    await handleCanvasSummary(req, res);
    return;
  }

  // GET /api/canvas/status
  if (pathname === "/api/canvas/status") {
    await handleCanvasStatus(req, res);
    return;
  }

  // POST /api/agent/chat
  if (pathname === "/api/agent/chat") {
    await handleAgentChat(req, res, parsed);
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
});

server.listen(CONFIG.port, () => {
  console.log(`姝ユ暟鍚庣宸插惎鍔? http://localhost:${CONFIG.port}`);
  if (CONFIG.appId === "YOUR_APP_ID") {
    console.log("鈿?灏氭湭閰嶇疆 appId / appSecret锛岃缂栬緫 server/server.js");
  }
});
