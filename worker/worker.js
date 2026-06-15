/**
 * Re-Bridge 受付 + 管理 + 申込者マイページ Worker
 * Custom Domain: rebridge-api.tamjump.com
 *
 * 公開:
 *   GET  /health
 *   POST /apply                 申込み受付（D1保存・通知/自動返信メール・トークン発行）
 * 申込者（トークンURL・ログイン不要）:
 *   GET  /t/<token>             マイページ（状況確認・メッセージ）
 *   GET  /api/thread?token=     スレッドJSON
 *   POST /api/thread/message    申込者メッセージ投稿 {token, body}
 * 管理（パスワードログイン）:
 *   GET  /admin                 管理画面
 *   POST /admin/login           {password} → 署名Cookie
 *   POST /admin/logout
 *   GET  /admin/api/me
 *   GET  /admin/api/list
 *   GET  /admin/api/item?id=
 *   POST /admin/api/status      {id,status}
 *   POST /admin/api/note        {id,note}
 *   POST /admin/api/message     {id,body} → 申込者へ通知（リンクのみ）
 *
 * 必須Secret: RESEND_API_KEY, NOTIFY_TO, ADMIN_PASSWORD, SESSION_SECRET
 * 必須Binding: DB (D1 "rebridge")  /  変数: FROM_EMAIL
 * メールにはPII（電話・会社名・メール）を載せない。中身は管理画面/マイページ内のみ。
 */

const SELF = "https://rebridge-api.tamjump.com";
const STATUSES = ["新規","連絡済","面談調整","対応中","完了","見送り"];

function cors(req){
  const o=req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": o||"*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json=(obj,status,req)=>new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json; charset=utf-8",...cors(req)}});
const page=(s,status=200)=>new Response(s,{status,headers:{"Content-Type":"text/html; charset=utf-8"}});

function genId(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; const r=crypto.getRandomValues(new Uint8Array(6)); for(const x of r) s+=a[x%a.length]; return "RB-"+s; }
function genToken(){ const r=crypto.getRandomValues(new Uint8Array(24)); return [...r].map(b=>b.toString(16).padStart(2,"0")).join(""); }

function b64url(bytes){ let bin=""; for(const b of bytes) bin+=String.fromCharCode(b); return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64urlDec(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }
async function hmac(secret,data){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}
async function makeSession(env){
  const payload=b64url(new TextEncoder().encode(JSON.stringify({exp:Date.now()+12*3600*1000})));
  return payload+"."+await hmac(env.SESSION_SECRET,payload);
}
async function verifySession(env,val){
  if(!val||!env.SESSION_SECRET) return false;
  const i=val.indexOf("."); if(i<0) return false;
  const p=val.slice(0,i), sig=val.slice(i+1);
  if(sig!==await hmac(env.SESSION_SECRET,p)) return false;
  try{ const o=JSON.parse(new TextDecoder().decode(b64urlDec(p))); return Date.now()<o.exp; }catch{ return false; }
}
function getCookie(req,name){
  const c=req.headers.get("Cookie")||""; const m=c.match(new RegExp("(?:^|; )"+name+"=([^;]+)")); return m?decodeURIComponent(m[1]):"";
}
function eqStr(a,b){ a=String(a||""); b=String(b||""); if(a.length!==b.length) return false; let r=0; for(let i=0;i<a.length;i++) r|=a.charCodeAt(i)^b.charCodeAt(i); return r===0; }

async function sendMail(env,o){
  if(!env.RESEND_API_KEY) return false;
  try{
    const body={from:env.FROM_EMAIL||"Re-Bridge <noreply@tamjump.com>",to:o.to,subject:o.subject,text:o.text};
    if(o.reply_to) body.reply_to=o.reply_to;
    const r=await fetch("https://api.resend.com/emails",{method:"POST",
      headers:{"Authorization":`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify(body)});
    return r.ok;
  }catch{ return false; }
}

export default {
  async fetch(req, env){
    const url=new URL(req.url), path=url.pathname, m=req.method;
    if(m==="OPTIONS") return new Response(null,{status:204,headers:cors(req)});

    if(m==="GET" && (path==="/"||path==="/health"))
      return json({ok:true,service:"rebridge-api",resend:!!env.RESEND_API_KEY,notify:!!env.NOTIFY_TO,d1:!!env.DB,admin:!!(env.ADMIN_PASSWORD&&env.SESSION_SECRET),ts:new Date().toISOString()},200,req);

    if(m==="POST" && path==="/apply") return handleApply(req,env);

    if(m==="GET" && path.startsWith("/t/")) return page(APPLICANT_HTML);
    if(m==="GET" && path==="/api/thread") return threadGet(req,env);
    if(m==="POST" && path==="/api/thread/message") return threadPost(req,env);

    if(m==="GET" && path==="/admin") return page(ADMIN_HTML);
    if(m==="POST" && path==="/admin/login") return adminLogin(req,env);
    if(m==="POST" && path==="/admin/logout") return adminLogout(req,env);
    if(path.startsWith("/admin/api/")) return adminApi(req,env,path,m);

    return json({error:"not_found"},404,req);
  },
};

/* ===================== 受付 ===================== */
async function handleApply(req,env){
  let b; try{ b=await req.json(); }catch{ return json({error:"invalid_json"},400,req); }
  const company=String(b.company||"").trim(), name=String(b.name||"").trim(),
        email=String(b.email||"").trim(), phone=String(b.phone||"").trim();
  if(!company||!name||!email||!phone||b.not_antisocial!==true) return json({error:"missing_fields"},422,req);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({error:"invalid_email"},422,req);

  const litigation=(String(b.litigation||"").trim()==="あり")?"あり":"なし";
  const now=new Date().toISOString();
  const row={
    id:genId(), token:genToken(), company, name, email, phone,
    region:String(b.region||"").trim(),
    litigation, litigation_note:String(b.litigation_note||"").trim(),
    debt:String(b.debt||"").trim(), trouble:String(b.trouble||"").trim(),
    status:"新規", admin_note:"", created_at:now, updated_at:now,
    ua:req.headers.get("user-agent")||"", ip:req.headers.get("cf-connecting-ip")||"",
  };

  let stored=false;
  if(env.DB){
    try{
      await env.DB.prepare(
        `INSERT INTO applications (id,token,company,name,email,phone,region,litigation,litigation_note,debt,trouble,status,admin_note,created_at,updated_at,ua,ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(row.id,row.token,row.company,row.name,row.email,row.phone,row.region,row.litigation,row.litigation_note,row.debt,row.trouble,row.status,row.admin_note,row.created_at,row.updated_at,row.ua,row.ip).run();
      stored=true;
    }catch(_){}
  }

  // 管理者通知（PIIなし・管理画面リンクのみ）
  let notified=false;
  if(env.NOTIFY_TO){
    notified=await sendMail(env,{
      to:env.NOTIFY_TO,
      subject:`[Re-Bridge] 新規申込み ${row.id}`,
      text:`新しい申込みを受け付けました。\n\n案件番号：${row.id}\n受付：${row.created_at}\n\n内容の確認・電話番号は管理画面から：\n${SELF}/admin`,
    });
  }

  // 申込者へ受付確認（返信先 info）。中身はマイページに置く。
  if(env.RESEND_API_KEY){
    const link = stored ? `\n\n状況の確認・メッセージのやり取りはこちらのページから行えます：\n${SELF}/t/${row.token}\n（このURLは大切に保管してください）` : "";
    await sendMail(env,{
      to:email,
      reply_to: env.REPLY_TO || env.NOTIFY_TO || "info@tamjump.com",
      subject:"【Re-Bridge】お申込みを受け付けました",
      text:
`${name} 様

お申込みをいただき、ありがとうございます。
Re-Bridge（タムジ株式会社）の大下と申します。

ご記入いただいた内容は、確かに受け取りました。
内容を確認のうえ、ご記入の電話番号へ折り返しご連絡いたします。

どのようなご状況でも、私たちにできる最大限のご協力をさせていただきます。
ご事情によっては、直接お会いしてお話しすることも可能です。${link}

──────────
大下 甚（おおした じん）
Re-Bridge ／ タムジ株式会社`,
    });
  }

  if(!stored && !notified) return json({error:"no_sink"},502,req);
  return json({ok:true,id:row.id,token:stored?row.token:undefined,stored,notified},200,req);
}

/* ===================== 申込者マイページ ===================== */
async function threadGet(req,env){
  if(!env.DB) return json({error:"no_db"},500,req);
  const token=new URL(req.url).searchParams.get("token")||"";
  if(!token) return json({error:"bad_token"},400,req);
  const a=await env.DB.prepare("SELECT id,company,name,status,created_at FROM applications WHERE token=?").bind(token).first();
  if(!a) return json({error:"not_found"},404,req);
  const ms=await env.DB.prepare("SELECT sender,body,created_at FROM messages WHERE app_id=? ORDER BY created_at ASC").bind(a.id).all();
  return json({ok:true,company:a.company,name:a.name,status:a.status,created_at:a.created_at,messages:ms.results||[]},200,req);
}
async function threadPost(req,env){
  if(!env.DB) return json({error:"no_db"},500,req);
  let b; try{ b=await req.json(); }catch{ return json({error:"invalid_json"},400,req); }
  const token=String(b.token||""), body=String(b.body||"").trim();
  if(!token||!body) return json({error:"missing"},400,req);
  const a=await env.DB.prepare("SELECT id FROM applications WHERE token=?").bind(token).first();
  if(!a) return json({error:"not_found"},404,req);
  const now=new Date().toISOString();
  await env.DB.prepare("INSERT INTO messages (id,app_id,sender,body,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),a.id,"applicant",body,now).run();
  await env.DB.prepare("UPDATE applications SET updated_at=? WHERE id=?").bind(now,a.id).run();
  if(env.NOTIFY_TO) await sendMail(env,{to:env.NOTIFY_TO,subject:`[Re-Bridge] 返信あり ${a.id}`,text:`申込者からメッセージが届きました。\n\n案件番号：${a.id}\n\n管理画面：\n${SELF}/admin`});
  return json({ok:true},200,req);
}

/* ===================== 管理 ===================== */
async function adminLogin(req,env){
  let b; try{ b=await req.json(); }catch{ return json({error:"invalid_json"},400,req); }
  if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET) return json({error:"not_configured"},500,req);
  const okUser = !env.ADMIN_USER || eqStr(b.user, env.ADMIN_USER);
  const okPw   = eqStr(b.password, env.ADMIN_PASSWORD);
  if(!okUser||!okPw) return json({error:"unauthorized"},401,req);
  const s=await makeSession(env);
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{
    "Content-Type":"application/json",
    "Set-Cookie":`rb_admin=${s}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=43200`,
  }});
}
function adminLogout(){
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{
    "Content-Type":"application/json",
    "Set-Cookie":"rb_admin=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0",
  }});
}
async function adminApi(req,env,path,m){
  const authed=await verifySession(env,getCookie(req,"rb_admin"));
  if(path==="/admin/api/me") return json({auth:authed},200,req);
  if(!authed) return json({error:"unauthorized"},401,req);
  if(!env.DB) return json({error:"no_db"},500,req);

  if(m==="GET" && path==="/admin/api/list"){
    const r=await env.DB.prepare("SELECT id,company,region,debt,status,created_at,updated_at FROM applications ORDER BY created_at DESC LIMIT 300").all();
    return json({ok:true,items:r.results||[]},200,req);
  }
  if(m==="GET" && path==="/admin/api/item"){
    const id=new URL(req.url).searchParams.get("id")||"";
    const a=await env.DB.prepare("SELECT * FROM applications WHERE id=?").bind(id).first();
    if(!a) return json({error:"not_found"},404,req);
    const ms=await env.DB.prepare("SELECT sender,body,created_at FROM messages WHERE app_id=? ORDER BY created_at ASC").bind(id).all();
    return json({ok:true,item:a,messages:ms.results||[]},200,req);
  }
  if(m==="POST" && path==="/admin/api/status"){
    const b=await req.json().catch(()=>({}));
    if(!STATUSES.includes(b.status)) return json({error:"bad_status"},400,req);
    await env.DB.prepare("UPDATE applications SET status=?,updated_at=? WHERE id=?").bind(b.status,new Date().toISOString(),String(b.id||"")).run();
    return json({ok:true},200,req);
  }
  if(m==="POST" && path==="/admin/api/note"){
    const b=await req.json().catch(()=>({}));
    await env.DB.prepare("UPDATE applications SET admin_note=?,updated_at=? WHERE id=?").bind(String(b.note||""),new Date().toISOString(),String(b.id||"")).run();
    return json({ok:true},200,req);
  }
  if(m==="POST" && path==="/admin/api/message"){
    const b=await req.json().catch(()=>({}));
    const id=String(b.id||""), body=String(b.body||"").trim();
    if(!id||!body) return json({error:"missing"},400,req);
    const a=await env.DB.prepare("SELECT email,token FROM applications WHERE id=?").bind(id).first();
    if(!a) return json({error:"not_found"},404,req);
    const now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO messages (id,app_id,sender,body,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),id,"admin",body,now).run();
    await env.DB.prepare("UPDATE applications SET updated_at=? WHERE id=?").bind(now,id).run();
    await sendMail(env,{to:a.email,reply_to:env.REPLY_TO||env.NOTIFY_TO||"info@tamjump.com",subject:"【Re-Bridge】メッセージが届きました",
      text:`Re-Bridge からメッセージが届きました。\n\n内容の確認・ご返信はこちらのページから：\n${SELF}/t/${a.token}`});
    return json({ok:true},200,req);
  }
  return json({error:"not_found"},404,req);
}

/* ===================== ページHTML ===================== */
const PAGE_CSS = `
:root{--paper:#fff;--ink:#14222e;--ink-2:#26384a;--ink-soft:#516275;--ink-faint:#90a1b2;--accent:#1c84cf;--accent-deep:#10568f;--line:rgba(20,34,46,.12);--line-strong:rgba(20,34,46,.22)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:var(--accent-deep)}
.wrap{max-width:1040px;margin:0 auto;padding:26px 20px 60px}
.top{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:22px}
.brand{font-weight:700;font-size:19px;letter-spacing:-.01em}.brand em{font-style:normal;color:var(--accent)}
h1{font-size:18px;margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:14px;font-weight:500;background:var(--accent);color:#fff;border:0;border-radius:3px;padding:11px 18px;cursor:pointer;transition:.2s}
.btn:hover{background:var(--accent-deep)}
.btn.ghost{background:#fff;color:var(--ink-soft);border:1px solid var(--line-strong)}
.btn.ghost:hover{color:var(--ink);background:#f7fafc}
input,select,textarea{width:100%;font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line-strong);border-radius:3px;padding:11px 12px;transition:.2s}
textarea{resize:vertical;min-height:80px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(28,132,207,.14)}
.muted{color:var(--ink-faint)}
.badge{display:inline-block;font-size:12px;padding:3px 9px;border:1px solid var(--accent);color:var(--accent-deep);border-radius:99px;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--ink-faint);font-weight:600;letter-spacing:.04em}
tbody tr{cursor:pointer}tbody tr:hover{background:#f7fafc}
.grid{display:grid;grid-template-columns:1.3fr 1fr;gap:26px;align-items:start}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{border:1px solid var(--line-strong);border-radius:4px;padding:20px}
.row{display:flex;gap:14px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.row:last-child{border-bottom:0}.row .k{flex:0 0 92px;color:var(--ink-faint);font-size:13px}.row .v{flex:1;word-break:break-word}
.sec{font-size:12px;color:var(--ink-faint);letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px}
.msgs{display:flex;flex-direction:column;gap:10px;margin:6px 0 14px}
.bub{max-width:80%;padding:10px 13px;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap}
.bub.them{align-self:flex-start;background:#f1f5f9;border:1px solid var(--line)}
.bub.me{align-self:flex-end;background:rgba(28,132,207,.10);border:1px solid var(--accent)}
.bub .meta{display:block;font-size:11px;color:var(--ink-faint);margin-top:5px}
.composer{display:flex;gap:10px;align-items:flex-end}.composer textarea{min-height:54px}
.center{max-width:420px;margin:60px auto;text-align:center}
.note{font-size:13px;color:var(--ink-faint);margin-top:10px}
.err{color:#b3261e;font-size:13px;min-height:18px;margin-top:8px}
`;

const ADMIN_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Re-Bridge 管理</title><style>${PAGE_CSS}</style></head><body>
<div class="wrap">
  <div class="top"><span class="brand">Re<em>／</em>Bridge 管理</span><div style="display:flex;gap:8px;align-items:center"><a class="btn ghost" href="https://rebridge.tamjump.com/" style="text-decoration:none">← サイトを見る</a><button class="btn ghost" id="logout" style="display:none">ログアウト</button></div></div>

  <div id="login" style="display:none">
    <div class="center">
      <h1 style="margin-bottom:18px">管理ログイン</h1>
      <form id="loginForm">
        <input id="uid" type="text" placeholder="ID" autocomplete="username" style="margin-bottom:10px" />
        <input id="pw" type="password" placeholder="パスワード" autocomplete="current-password" autofocus />
        <div class="err" id="loginErr"></div>
        <button class="btn" style="width:100%;margin-top:6px">ログイン</button>
      </form>
    </div>
  </div>

  <div id="app" style="display:none">
    <div class="grid">
      <div>
        <div class="sec">申込み一覧</div>
        <table><thead><tr><th>受付</th><th>会社名</th><th>地域</th><th>借入</th><th>状況</th></tr></thead><tbody id="list"></tbody></table>
      </div>
      <div>
        <div class="sec">詳細</div>
        <div id="panel" class="card" style="display:none">
          <div id="detail"></div>
          <div class="sec">状況</div>
          <select id="statusSel"></select>
          <div class="sec">社内メモ</div>
          <textarea id="note" placeholder="社内メモ（申込者には表示されません）"></textarea>
          <div style="display:flex;gap:10px;align-items:center;margin-top:8px"><button class="btn ghost" id="saveNote">メモを保存</button><span class="muted" id="noteMsg" style="font-size:13px"></span></div>
          <div class="sec">メッセージ（申込者とやり取り）</div>
          <div class="msgs" id="msgs"></div>
          <form id="msgForm" class="composer"><textarea id="msgBox" placeholder="申込者へ送るメッセージ（送信すると相手にリンク通知が届きます）"></textarea><button class="btn">送信</button></form>
        </div>
        <div id="empty" class="muted" style="font-size:14px">左の一覧から案件を選んでください。</div>
      </div>
    </div>
  </div>
</div>
<script>
var S=["新規","連絡済","面談調整","対応中","完了","見送り"];var cur=null;
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function fmt(iso){try{return new Date(iso).toLocaleString("ja-JP",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch(e){return iso;}}
async function me(){var r=await fetch("/admin/api/me");return (await r.json()).auth;}
function show(v){el("login").style.display=v==="login"?"block":"none";el("app").style.display=v==="app"?"block":"none";el("logout").style.display=v==="app"?"inline-flex":"none";}
async function boot(){ if(await me()){show("app");loadList();} else show("login"); }
el("loginForm").onsubmit=async function(e){e.preventDefault();el("loginErr").textContent="";var r=await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user:el("uid").value,password:el("pw").value})});if(r.ok){show("app");loadList();}else{el("loginErr").textContent="IDまたはパスワードが違います。";}};
el("logout").onclick=async function(){await fetch("/admin/logout",{method:"POST"});location.reload();};
async function loadList(){var r=await fetch("/admin/api/list");if(r.status===401){show("login");return;}var j=await r.json();var t=el("list");t.innerHTML="";(j.items||[]).forEach(function(a){var tr=document.createElement("tr");tr.innerHTML="<td>"+fmt(a.created_at)+"</td><td>"+esc(a.company)+"</td><td>"+esc(a.region||"-")+"</td><td>"+esc(a.debt||"-")+"</td><td><span class='badge'>"+esc(a.status)+"</span></td>";tr.onclick=function(){openItem(a.id);};t.appendChild(tr);});if(!(j.items||[]).length)t.innerHTML="<tr><td colspan='5' class='muted'>まだ申込みはありません。</td></tr>";}
function rowHtml(k,v){return "<div class='row'><span class='k'>"+k+"</span><span class='v'>"+v+"</span></div>";}
function renderMsgs(list){var c=el("msgs");c.innerHTML="";(list||[]).forEach(function(mm){var d=document.createElement("div");d.className="bub "+(mm.sender==="admin"?"me":"them");d.innerHTML=esc(mm.body)+"<span class='meta'>"+(mm.sender==="admin"?"自社":"申込者")+" ・ "+fmt(mm.created_at)+"</span>";c.appendChild(d);});if(!(list||[]).length)c.innerHTML="<span class='muted' style='font-size:13px'>まだメッセージはありません。</span>";}
async function openItem(id){var r=await fetch("/admin/api/item?id="+encodeURIComponent(id));if(!r.ok)return;var j=await r.json();var a=j.item;cur=id;el("empty").style.display="none";el("panel").style.display="block";
 var h="";
 h+=rowHtml("案件",esc(a.id));
 h+=rowHtml("電話","<a href='tel:"+esc(a.phone)+"'>"+esc(a.phone)+"</a>");
 h+=rowHtml("会社名",esc(a.company));
 h+=rowHtml("お名前",esc(a.name));
 h+=rowHtml("メール","<a href='mailto:"+esc(a.email)+"'>"+esc(a.email)+"</a>");
 h+=rowHtml("地域",esc(a.region||"-"));
 h+=rowHtml("訴訟",esc(a.litigation)+(a.litigation_note?"（"+esc(a.litigation_note)+"）":""));
 h+=rowHtml("借入",esc(a.debt||"-"));
 h+=rowHtml("困りごと",esc(a.trouble||"-"));
 h+=rowHtml("受付",fmt(a.created_at));
 el("detail").innerHTML=h;
 var sel=el("statusSel");sel.innerHTML="";S.forEach(function(s){var o=document.createElement("option");o.textContent=s;if(s===a.status)o.selected=true;sel.appendChild(o);});
 el("note").value=a.admin_note||"";el("noteMsg").textContent="";
 renderMsgs(j.messages);
}
el("statusSel").onchange=async function(){if(!cur)return;await fetch("/admin/api/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:cur,status:this.value})});loadList();};
el("saveNote").onclick=async function(){if(!cur)return;await fetch("/admin/api/note",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:cur,note:el("note").value})});el("noteMsg").textContent="保存しました";setTimeout(function(){el("noteMsg").textContent="";},1500);};
el("msgForm").onsubmit=async function(e){e.preventDefault();if(!cur)return;var b=el("msgBox").value.trim();if(!b)return;await fetch("/admin/api/message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:cur,body:b})});el("msgBox").value="";openItem(cur);};
boot();
</script>
</body></html>`;

const APPLICANT_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Re-Bridge お申込み状況</title><style>${PAGE_CSS}</style></head><body>
<div class="wrap" style="max-width:680px">
  <div class="top"><span class="brand">Re<em>／</em>Bridge</span></div>
  <div id="wrap">
    <h1 style="margin-bottom:4px">お申込み状況</h1>
    <p class="muted" style="font-size:14px;margin-top:4px">このページのURLは、あなた専用です。大切に保管してください。</p>
    <div class="card" style="margin-top:18px">
      <div class="row"><span class="k">会社名</span><span class="v" id="co">—</span></div>
      <div class="row"><span class="k">現在の状況</span><span class="v"><span class="badge" id="st">—</span></span></div>
    </div>
    <div class="sec">メッセージ</div>
    <div class="msgs" id="msgs"></div>
    <form id="f" class="composer"><textarea id="b" placeholder="ご質問・ご状況など、お気軽にどうぞ"></textarea><button class="btn">送信</button></form>
    <p class="note">送信した内容は担当者に届きます。お急ぎの場合は、受付確認メールへの返信でもご連絡いただけます。</p>
  </div>
</div>
<script>
var token=(location.pathname.split("/t/")[1]||"").split(/[?#]/)[0];
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function fmt(iso){try{return new Date(iso).toLocaleString("ja-JP",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch(e){return iso;}}
function renderMsgs(list){var c=el("msgs");c.innerHTML="";(list||[]).forEach(function(mm){var d=document.createElement("div");d.className="bub "+(mm.sender==="applicant"?"me":"them");d.innerHTML=esc(mm.body)+"<span class='meta'>"+(mm.sender==="applicant"?"あなた":"Re-Bridge")+" ・ "+fmt(mm.created_at)+"</span>";c.appendChild(d);});if(!(list||[]).length)c.innerHTML="<span class='muted' style='font-size:13px'>まだメッセージはありません。</span>";}
async function load(){var r=await fetch("/api/thread?token="+encodeURIComponent(token));if(!r.ok){el("wrap").innerHTML="<h1>ページが見つかりませんでした</h1><p class='muted'>URLをご確認ください。</p>";return;}var j=await r.json();el("co").textContent=j.company;el("st").textContent=j.status;renderMsgs(j.messages);}
el("f").onsubmit=async function(e){e.preventDefault();var b=el("b").value.trim();if(!b)return;await fetch("/api/thread/message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token,body:b})});el("b").value="";load();};
load();
</script>
</body></html>`;
