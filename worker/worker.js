/**
 * Re-Bridge 引受診断フォーム受付 Worker
 * route: rebridge-api.tamjump.com/apply
 * binding: DB (D1) / 任意で RESEND_API_KEY, NOTIFY_TO を Secrets に設定
 */
const CORS = {
  "Access-Control-Allow-Origin": "https://rebridge.tamjump.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/apply") {
      return json({ error: "not_found" }, 404);
    }

    let b;
    try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

    const company = String(b.company || "").trim();
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim();
    const industry = String(b.industry_scope || "").trim();
    if (!company || !name || !email || !industry || b.consent !== true) {
      return json({ error: "missing_fields" }, 422);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid_email" }, 422);

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

    // D1 へ保存
    if (env.DB) {
      await env.DB.prepare(
        `INSERT INTO applications
         (id, company, name, email, phone, industry_scope, situation, unexpected_value, created_at, ua, ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        row.id, row.company, row.name, row.email, row.phone,
        row.industry_scope, row.situation, row.unexpected_value, row.created_at, row.ua, row.ip
      ).run();
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

受付: ${row.created_at}`,
          }),
        });
      } catch (_) { /* 通知失敗は受付成功に影響させない */ }
    }

    return json({ ok: true, id: row.id }, 200);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
