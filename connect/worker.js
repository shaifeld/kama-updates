// kama-connect: מחליף קוד OAuth של גיטהאב במפתח גישה.
// סודות (בהגדרות קלאודפלייר בלבד): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
// לא שומר, לא מדפיס ליומנים, ומקבל פניות רק מדף ההקמה.
const ORIGIN = "https://shaifeld.github.io";
const REDIRECT = "https://shaifeld.github.io/kama-connect/";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
};

function reply(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// הגבלת קצב פנימית: עד 10 בקשות בדקה לכל כתובת IP (לכל מופע של השרת)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 10;
}

export default {
  async fetch(req, env) {
    if (req.headers.get("Origin") !== ORIGIN) return reply({ error: "forbidden" }, 403);
    if (req.method !== "OPTIONS" && limited(req.headers.get("CF-Connecting-IP") || "?")) return reply({ error: "rate_limited" }, 429);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply({ error: "method" }, 405);
    if (!(req.headers.get("Content-Type") || "").startsWith("application/json")) return reply({ error: "type" }, 415);
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return reply({ error: "not_configured" }, 500);

    let code;
    try {
      const text = await req.text();
      if (text.length > 1000) return reply({ error: "too_large" }, 413);
      const body = JSON.parse(text);
      code = body && body.code;
    } catch (e) {
      return reply({ error: "bad_json" }, 400);
    }
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{10,64}$/.test(code)) {
      return reply({ error: "bad_code" }, 400);
    }

    let data = {};
    try {
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT,
        }),
      });
      data = await r.json();
    } catch (e) {
      return reply({ error: "github_unreachable" }, 502);
    }
    if (!data.access_token) return reply({ error: data.error || "exchange_failed" }, 400);
    return reply({ access_token: data.access_token, scope: data.scope || "" }, 200);
  },
};
