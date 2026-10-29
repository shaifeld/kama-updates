// Kama Ani Ashir – AI relay (Cloudflare Worker).
// Holds the Gemini key so customers never need one. Checks that the caller has an active
// activation code, forwards the request to Gemini, and keeps nothing.
// Secrets to set in Cloudflare (Settings → Variables and Secrets):
//   GEMINI_KEY  – the key from Google AI Studio (required)
//   MODEL       – optional, e.g. gemini-2.5-flash (default: newest Flash model found)
const FB_KEY = "AIzaSyAdljoZOi3pmXquXYxQGZ68MWiKLgu310M";
const FB_PROJECT = "kama-ani-ashir";
const MAX_BODY = 6_000_000;
const DAY_LIMIT = 60;    // requests per code per day (per worker instance, best effort)
const TRIAL_LIMIT = 15;  // per trial user (no code yet) per day
const TRIAL_TOTAL = 400; // all trial users together per day

let fbTok = null, fbExp = 0;
const okCodes = new Map();   // code -> time verified
const counts = new Map();    // code|day -> n

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

async function firebaseToken() {
  if (fbTok && Date.now() < fbExp - 60000) return fbTok;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  fbTok = j.idToken; fbExp = Date.now() + (+j.expiresIn || 3600) * 1000;
  return fbTok;
}

async function codeActive(code) {
  if (!/^KMA-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code || "")) return false;
  const t = okCodes.get(code);
  if (t && Date.now() - t < 6 * 3600e3) return true;
  const tok = await firebaseToken();
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/licenses/${code}`, { headers: { Authorization: "Bearer " + tok } });
  if (r.status !== 200) return false;
  const d = await r.json();
  const st = d.fields && d.fields.status && d.fields.status.stringValue;
  if (st === "off") return false;
  okCodes.set(code, Date.now());
  return true;
}

async function trialUid(idToken) {
  if (!idToken || idToken.length > 4000) return "";
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
  if (r.status !== 200) return "";
  const j = await r.json();
  return (j.users && j.users[0] && j.users[0].localId) || "";
}

const tfetch = (u, o = {}, ms = 25000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(u, { ...o, signal: c.signal }).finally(() => clearTimeout(t)); };

let models = null, modelsAt = 0;
const bad = new Map(); // model -> until
async function modelList(env) {
  if (env.MODEL) return [env.MODEL];
  if (models && Date.now() - modelsAt < 6 * 3600e3) return models;
  let names = [];
  try {
    const r = await tfetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${env.GEMINI_KEY}`, {}, 8000);
    const j = await r.json();
    names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name) && !/tts|image|live|audio|thinking|exp/i.test(m.name)).map(m => m.name.replace("models/", ""));
  } catch (e) {}
  const v = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
  // full models first (newest first), then lite; "latest" aliases after numbered ones
  names.sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (v(b) - v(a)));
  if (!names.length) names = ["gemini-3-flash-preview", "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
  models = names; modelsAt = Date.now();
  return models;
}
async function generate(env, payload) {
  const list = (await modelList(env)).filter(m => !(bad.get(m) > Date.now()));
  const tries = (list.length ? list : await modelList(env)).slice(0, 4);
  let last = null;
  for (let i = 0; i < tries.length; i++) {
    const m = tries[i];
    try {
      const r = await tfetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, i === 0 ? 20000 : 15000);
      if (r.status === 200 || r.status === 400) return r;
      last = r; bad.set(m, Date.now() + 10 * 60e3);
    } catch (e) { bad.set(m, Date.now() + 6 * 3600e3); } // hung: skip for hours
  }
  return last || json({ error: "ai unavailable" }, 503);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") {
      if (new URL(req.url).searchParams.has("diag") && env.GEMINI_KEY) {
        const t0 = Date.now(); const order = await modelList(env);
        const r = await generate(env, { contents: [{ role: "user", parts: [{ text: "say ok" }] }] });
        return json({ order, status: r.status, ms: Date.now() - t0, bad: [...bad.keys()] });
      }
      return json({ ok: true, service: "kama-ai" });
    }
    if (!env.GEMINI_KEY) return json({ error: "server not configured" }, 500);
    const len = +req.headers.get("content-length") || 0;
    if (len > MAX_BODY) return json({ error: "too big" }, 413);
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const code = String(body.lic || "").toUpperCase();
    const day = new Date().toISOString().slice(0, 10);
    let k, lim;
    if (await codeActive(code)) { k = code + "|" + day; lim = DAY_LIMIT; }
    else {
      // trial: a signed-in app user without a code yet (verified with Firebase)
      const uid = await trialUid(String(body.tok || ""));
      if (!uid) return json({ error: "no active code" }, 403);
      const t = "trial|" + day, tn = (counts.get(t) || 0) + 1; counts.set(t, tn);
      if (tn > TRIAL_TOTAL) return json({ error: "daily limit" }, 429);
      k = uid + "|" + day; lim = TRIAL_LIMIT;
    }
    const n = (counts.get(k) || 0) + 1; counts.set(k, n);
    if (n > lim) return json({ error: "daily limit" }, 429);
    if (!Array.isArray(body.contents)) return json({ error: "no contents" }, 400);
    const r = await generate(env, { contents: body.contents, generationConfig: body.generationConfig || {}, systemInstruction: body.systemInstruction });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
  },
};
