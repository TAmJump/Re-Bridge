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
          email=String(b.email||"").trim(), phone=String(b.phone||"").trim();
    // 必須: 会社名・お名前・電話・メール・反社でない確認
    if(!company||!name||!email||!phone||b.not_antisocial!==true) return json({error:"missing_fields"},422,req);
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({error:"invalid_email"},422,req);

    const litigation=(String(b.litigation||"").trim()==="あり")?"あり":"なし";
    const row={
      id:crypto.randomUUID(), company, name, email, phone,
      region:String(b.region||"").trim(),
      litigation, litigation_note:String(b.litigation_note||"").trim(),
      debt:String(b.debt||"").trim(),
      trouble:String(b.trouble||"").trim(),
      created_at:new Date().toISOString(),
      ua:req.headers.get("user-agent")||"", ip:req.headers.get("cf-connecting-ip")||"",
    };

    // 任意：D1保存（バインドがある時だけ）
    let stored=false;
    if(env.DB){
      try{
        await env.DB.prepare(
          `INSERT INTO applications (id,company,name,email,phone,region,litigation,litigation_note,debt,trouble,created_at,ua,ip)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(row.id,row.company,row.name,row.email,row.phone,row.region,row.litigation,row.litigation_note,row.debt,row.trouble,row.created_at,row.ua,row.ip).run();
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
            subject:`[Re-Bridge] 申込み：${company}／☎ ${phone}`,
            text:
`☎ 電話：${phone}

会社名：${company}
お名前：${name}
メール：${email}
地域：${row.region||"-"}
訴訟・係争：${litigation}${row.litigation_note?`（${row.litigation_note}）`:""}
借入のおおよそ：${row.debt||"-"}
今いちばん大変なこと：${row.trouble||"-"}

受付：${row.created_at}
保存(D1)：${stored?"OK":"未"}`,
          }),
        });
        emailed=r.ok;
      }catch(_){}
    }

    // 申込者への自動返信（受付確認）。reply_to は info@tamjump.com 等にして「返信」が届くように。失敗しても受付は成立。
    if(env.RESEND_API_KEY){
      try{
        await fetch("https://api.resend.com/emails",{
          method:"POST",
          headers:{ "Authorization":`Bearer ${env.RESEND_API_KEY}`, "Content-Type":"application/json" },
          body:JSON.stringify({
            from: env.FROM_EMAIL || "Re-Bridge <noreply@tamjump.com>",
            to: email,
            reply_to: env.REPLY_TO || env.NOTIFY_TO || "info@tamjump.com",
            subject:"【Re-Bridge】お申込みを受け付けました",
            text:
`${name} 様

お申込みをいただき、ありがとうございます。
Re-Bridge（タムジ株式会社）の大下と申します。

ご記入いただいた内容は、確かに受け取りました。
内容を確認のうえ、ご記入の電話番号へ折り返しご連絡いたします。

どのようなご状況でも、私たちにできる最大限のご協力をさせていただきます。
ご事情によっては、直接お会いしてお話しすることも可能です。

このメールにそのままご返信いただければ、私に直接届きます。

──────────
大下 甚（おおした じん）
Re-Bridge ／ タムジ株式会社`,
          }),
        });
      }catch(_){}
    }

    // どこにも届かない場合は失敗を返す → フロントのメール送信フォールバックが起動（取りこぼし防止）
    if(!stored && !emailed) return json({error:"no_sink",hint:"set RESEND_API_KEY & NOTIFY_TO (or enable D1)"},502,req);
    return json({ok:true,id:row.id,stored,emailed},200,req);
  },
};
