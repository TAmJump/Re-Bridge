/**
 * Re-Bridge 引受診断フォーム受付 Worker
 * Custom Domain: rebridge-api.tamjump.com（wrangler.toml の routes で自動作成）
 * Path: POST /apply
 * Binding: DB (D1)。任意で RESEND_API_KEY / NOTIFY_TO を Secrets に設定するとメール通知。
 */

function cors(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": o || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(req) },
  });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

    const url = new URL(req.url);
    // ヘルスチェック（ブラウザで直接開いて疎通確認できる）
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "rebridge-api", ts: new Date().toISOString() }, 200, req);
    }
    if (req.method !== "POST" || url.pathname !== "/apply") return json({ error: "not_found" }, 404, req);

    let b;
    try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400, req); }

    const company = String(b.company || "").trim();
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim();
    const industry = String(b.industry_scope || "").trim();
    if (!company || !name || !email || !industry || b.consent !== true) {
      return json({ error: "missing_fields" }, 422, req);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid_email" }, 422, req);

    const row = {
      id: crypto.randomUUID(),
      company, name, email,
      phone: String(b.phone || "").trim(),
      industry_scope: industry,
      situation: String(b.situation || "").trim(),
      unexpected_value: String(b.unexpected_value || "").trim(),
      created_at: new Date().toISOString(),
      ua: req.headers.get("user-agent") || "",
      ip: req.headers.get("cf-connecting-ip") || "",
    };

    // D1 へ保存（失敗しても受付は継続）
    let stored = false;
    if (env.DB) {
      try {
        await env.DB.prepare(
          `INSERT INTO applications
           (id, company, name, email, phone, industry_scope, situation, unexpected_value, created_at, ua, ip)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          row.id, row.company, row.name, row.email, row.phone,
          row.industry_scope, row.situation, row.unexpected_value, row.created_at, row.ua, row.ip
        ).run();
        stored = true;
      } catch (e) { /* 保存失敗はメール通知側で拾う */ }
    }

    // 通知メール（Resend / 任意）
    if (env.RESEND_API_KEY && env.NOTIFY_TO) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Re-Bridge <noreply@tamjump.com>",
            to: env.NOTIFY_TO,
            reply_to: email,
            subject: `【Re-Bridge】引受診断 申込み：${company}`,
            text:
`会社名: ${company}
お名前: ${name}
メール: ${email}
電話: ${row.phone || "-"}
業種: ${industry}
状況: ${row.situation || "-"}
残っている資産:
${row.unexpected_value || "-"}

受付: ${row.created_at}
保存(D1): ${stored ? "OK" : "未"}`,
          }),
        });
      } catch (_) { /* 通知失敗は受付成功に影響させない */ }
    }

    return json({ ok: true, id: row.id, stored }, 200, req);
  },
};
