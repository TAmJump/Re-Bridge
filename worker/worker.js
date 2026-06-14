/**
 * Re-Bridge 引受診断フォーム受付 Worker
 * Custom Domain: rebridge-api.tamjump.com（wrangler.toml の routes で自動作成）
 * POST /apply  → Resend でメール通知（任意でD1保存）
 * 必須Secret: RESEND_API_KEY, NOTIFY_TO   設定: npx wrangler secret put <NAME>
 * GET /health → 疎通確認
 */
function cors(req){
  const o=req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": o||"*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json=(obj,status,req)=>new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json",...cors(req)}});

export default {
  async fetch(req, env){
    if(req.method==="OPTIONS") return new Response(null,{status:204,headers:cors(req)});
    const url=new URL(req.url);
    if(req.method==="GET" && (url.pathname==="/"||url.pathname==="/health"))
      return json({ok:true,service:"rebridge-api",resend:!!env.RESEND_API_KEY,notify:!!env.NOTIFY_TO,d1:!!env.DB,ts:new Date().toISOString()},200,req);
    if(req.method!=="POST"||url.pathname!=="/apply") return json({error:"not_found"},404,req);

    let b; try{ b=await req.json(); }catch{ return json({error:"invalid_json"},400,req); }
    const company=String(b.company||"").trim(), name=String(b.name||"").trim(),
          email=String(b.email||"").trim(), industry=String(b.industry_scope||"").trim();
    if(!company||!name||!email||!industry||b.consent!==true) return json({error:"missing_fields"},422,req);
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({error:"invalid_email"},422,req);

    const row={
      id:crypto.randomUUID(), company, name, email,
      phone:String(b.phone||"").trim(), industry_scope:industry,
      situation:String(b.situation||"").trim(), unexpected_value:String(b.unexpected_value||"").trim(),
      created_at:new Date().toISOString(),
      ua:req.headers.get("user-agent")||"", ip:req.headers.get("cf-connecting-ip")||"",
    };

    // 任意：D1保存（バインドがある時だけ）
    let stored=false;
    if(env.DB){
      try{
        await env.DB.prepare(
          `INSERT INTO applications (id,company,name,email,phone,industry_scope,situation,unexpected_value,created_at,ua,ip)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(row.id,row.company,row.name,row.email,row.phone,row.industry_scope,row.situation,row.unexpected_value,row.created_at,row.ua,row.ip).run();
        stored=true;
      }catch(_){}
    }

    // メール通知（Resend）
    let emailed=false;
    if(env.RESEND_API_KEY && env.NOTIFY_TO){
      try{
        const r=await fetch("https://api.resend.com/emails",{
          method:"POST",
          headers:{ "Authorization":`Bearer ${env.RESEND_API_KEY}`, "Content-Type":"application/json" },
          body:JSON.stringify({
            from: env.FROM_EMAIL || "Re-Bridge <noreply@tamjump.com>",
            to: env.NOTIFY_TO,
            reply_to: email,
            subject:`[ReBridge／M&A] 引受診断 申込み：${company}`,
            text:
`会社名: ${company}
お名前: ${name}
メール: ${email}
電話: ${row.phone||"-"}
業種: ${industry}
現在の状況: ${row.situation||"-"}
残っている資産:
${row.unexpected_value||"-"}

受付: ${row.created_at}
保存(D1): ${stored?"OK":"未"}`,
          }),
        });
        emailed=r.ok;
      }catch(_){}
    }

    // どこにも届かない場合は失敗を返す → フロントのメール送信フォールバックが起動（取りこぼし防止）
    if(!stored && !emailed) return json({error:"no_sink",hint:"set RESEND_API_KEY & NOTIFY_TO (or enable D1)"},502,req);
    return json({ok:true,id:row.id,stored,emailed},200,req);
  },
};
