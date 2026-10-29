// Kama Ani Ashir – AI relay (Cloudflare Worker).
// Holds the Gemini key so customers never need one. Checks that the caller has an active
// activation code, forwards the request to Gemini, and keeps nothing.
// Secrets to set in Cloudflare (Settings → Variables and Secrets):
//   GEMINI_KEY  – the key from Google AI Studio (required)
//   MODEL       – optional, e.g. gemini-2.5-flash (default: newest Flash model found)
const FB_KEY = "AIzaSyAdljoZOi3pmXquXYxQGZ68MWiKLgu310M";
const FB_PROJECT = "kama-ani-ashir";
const MAX_BODY = 6_000_000;
const DAY_LIMIT = 60; // requests per code per day (per worker instance, best effort)

let fbTok = null, fbExp = 0, model = null;
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

async function pickModel(env) {
  if (env.MODEL) return env.MODEL;
  if (model) return model;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${env.GEMINI_KEY}`);
    const j = await r.json();
    const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name) && !/lite|tts|image|live|audio|thinking|exp|preview/i.test(m.name));
    const v = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
    ok.sort((a, b) => v(b.name) - v(a.name));
    model = (ok[0] && ok[0].name.replace("models/", "")) || "gemini-2.5-flash";
  } catch (e) { model = "gemini-2.5-flash"; }
  return model;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ ok: true, service: "kama-ai" });
    if (!env.GEMINI_KEY) return json({ error: "server not configured" }, 500);
    const len = +req.headers.get("content-length") || 0;
    if (len > MAX_BODY) return json({ error: "too big" }, 413);
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const code = String(body.lic || "").toUpperCase();
    if (!(await codeActive(code))) return json({ error: "no active code" }, 403);
    const day = new Date().toISOString().slice(0, 10), k = code + "|" + day;
    const n = (counts.get(k) || 0) + 1; counts.set(k, n);
    if (n > DAY_LIMIT) return json({ error: "daily limit" }, 429);
    if (!Array.isArray(body.contents)) return json({ error: "no contents" }, 400);
    const m = await pickModel(env);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: body.contents, generationConfig: body.generationConfig || {}, systemInstruction: body.systemInstruction }),
    });
    const text = await r.text();
    if (r.status === 404) model = null;
    return new Response(text, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
  },
};
