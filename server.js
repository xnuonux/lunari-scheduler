// LUNARI Scheduler + Execution Backend v3
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const CONFIG = {
  ANTHROPIC_KEY:    process.env.ANTHROPIC_API_KEY  || '',
  NETLIFY_TOKEN:    process.env.NETLIFY_API_TOKEN   || '',
  SUPABASE_URL:     process.env.SUPABASE_URL        || '',
  SUPABASE_KEY:     process.env.SUPABASE_KEY        || '',
  EMAILJS_SERVICE:  process.env.EMAILJS_SERVICE_ID  || 'service_3d0r898',
  EMAILJS_TEMPLATE: process.env.EMAILJS_TEMPLATE_ID || 'template_j4ecn66',
  EMAILJS_KEY:      process.env.EMAILJS_PUBLIC_KEY  || 'SnGkSaX1ThQBSysOU',
  PORT:             process.env.PORT                 || 3000,
};

const BUILD_RESULTS = {};
const PLAN_LIMITS   = { free: 1, starter: 1, subscriber: 1, pro: 2, studio: 5 };

// ── Supabase helpers ─────────────────────────────
function sbFetch(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) return resolve(null);
    const u = new URL(CONFIG.SUPABASE_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, path: '/rest/v1/' + path, method,
      headers: {
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getUserSiteData(userId) {
  if (!userId || userId === 'demo') return null;
  const rows = await sbFetch('GET', `user_credits?user_id=eq.${userId}&select=sites_built,site_limit,plan&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function checkSiteLimit(userId) {
  const data = await getUserSiteData(userId);
  if (!data) return { allowed: true };
  const limit = data.site_limit || PLAN_LIMITS[data.plan] || 1;
  const built = data.sites_built || 0;
  return { allowed: built < limit, built, limit, plan: data.plan };
}

async function incrementSiteCount(userId) {
  if (!userId || userId === 'demo') return;
  const data = await getUserSiteData(userId);
  const current = data ? (data.sites_built || 0) : 0;
  await sbFetch('PATCH', `user_credits?user_id=eq.${userId}`, { sites_built: current + 1 });
}

// ── CRON helpers ─────────────────────────────────
function parseCron(expr) {
  const p = expr.trim().split(/\s+/);
  return p.length !== 5 ? null : { minute:p[0], hour:p[1], dom:p[2], month:p[3], dow:p[4] };
}
function cronMatches(expr, date) {
  const c = parseCron(expr); if (!c) return false;
  const m = (f,v) => { if(f==='*')return true; if(f.includes('/'))return v%parseInt(f.split('/')[1])===0; if(f.includes(','))return f.split(',').map(Number).includes(v); if(f.includes('-')){const[a,b]=f.split('-').map(Number);return v>=a&&v<=b;} return parseInt(f)===v; };
  return m(c.minute,date.getMinutes())&&m(c.hour,date.getHours())&&m(c.dom,date.getDate())&&m(c.month,date.getMonth()+1)&&m(c.dow,date.getDay());
}
function getNextRun(expr) {
  const n=new Date(Date.now()+60000);
  for(let i=0;i<60*24*7;i++){n.setMinutes(n.getMinutes()+1);if(cronMatches(expr,n))return n.toISOString();}
  return null;
}

// ── Schedules ────────────────────────────────────
let SCHEDULES = [
  {id:'s1',name:'Morning Intelligence Briefing',agent:'scout',prompt:'Research the top 5 most important AI and technology news stories from the last 24 hours. Headline, 2-sentence summary, and why it matters for solo founders.',schedule:'0 8 * * *',email:'',enabled:true,lastRun:null,nextRun:getNextRun('0 8 * * *')},
  {id:'s2',name:'Weekly Marketing Strategy',agent:'spark',prompt:'Generate a complete 7-day marketing action plan for a solo founder. 3 content ideas, 1 email subject line, 1 growth tactic, 1 competitor to research.',schedule:'0 9 * * 1',email:'',enabled:false,lastRun:null,nextRun:getNextRun('0 9 * * 1')},
  {id:'s3',name:'Daily Content Piece',agent:'prose',prompt:'Write one high-quality LinkedIn post for a solo founder in the AI/technology space. 150-200 words, strong hook, ends with a question.',schedule:'0 10 * * *',email:'',enabled:false,lastRun:null,nextRun:getNextRun('0 10 * * *')},
];

// ── Build system ─────────────────────────────────
function detectBuildType(task) {
  const l=task.toLowerCase();
  if(l.includes('landing page')||l.includes('landing'))return 'landing';
  if(l.includes('portfolio'))return 'portfolio';
  if(l.includes('blog'))return 'blog';
  if(l.includes('saas')||l.includes('platform'))return 'saas';
  if(l.includes('store')||l.includes('shop'))return 'ecommerce';
  if(l.includes('music')||l.includes('artist')||l.includes('band'))return 'music';
  return 'landing';
}

function generateSlug(text) {
  const clean = text.toLowerCase()
    .replace(/build me a?n?\s*|create a?n?\s*|make a?n?\s*|landing page|website|platform|app|for\s+/gi,'')
    .replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,20).replace(/^-|-$/g,'');
  return (clean||'site')+'-'+Math.random().toString(36).slice(2,6);
}

function buildWithClaude(task, buildType, siteName) {
  return new Promise((resolve,reject) => {
    const system=`You are a web developer. Output a single HTML file. Rules: (1) Start with <!DOCTYPE html> immediately. (2) No markdown, no code fences, no explanation. (3) The body MUST have visible text content — headings, paragraphs, buttons. (4) Text must be a different color from the background. (5) Use white or light colored text on dark backgrounds, or dark text on light backgrounds. (6) Never use CSS that hides or makes content invisible. (7) Include at minimum: a visible h1 heading, a paragraph of text, and a styled button. These must be readable on screen.`;
    const user=`Build a landing page for: ${task}
Brand name: ${siteName||'extract from the task'}

Your output must be a complete HTML file starting with <!DOCTYPE html>.

The page must include ALL of these visible elements:
1. A large H1 heading with the brand name (use color: #c8f04a or similar bright color)
2. A subheading paragraph describing what the product does (use color: #cccccc)
3. A CTA button with background-color and contrasting text
4. A features section with at least 3 items
5. A footer

CSS requirements:
- body { background-color: #0d0d1a; color: #ffffff; margin: 0; font-family: sans-serif; }
- All text must be visible — light text on dark background
- Do NOT use visibility:hidden, opacity:0, or display:none on main content

Start your response with <!DOCTYPE html> immediately. No other text.`;
    const rb=JSON.stringify({model:'claude-opus-4-6',max_tokens:8000,system,messages:[{role:'user',content:user}]});
    const opts={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':CONFIG.ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}};
    const req=https.request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));
      const t=p.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const clean=t.replace(/^```html\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
      if(!clean.includes('<!DOCTYPE')&&!clean.includes('<html'))return reject(new Error('Claude did not return valid HTML'));
      resolve(clean);}catch(e){reject(e);}
    });});
    req.on('error',reject);req.write(rb);req.end();
  });
}

function assignCustomDomain(siteId, domain) {
  return new Promise((resolve, reject) => {
    // Netlify uses POST to /api/v1/sites/{id}/aliases to add a domain alias
    const body = JSON.stringify([domain]);
    const opts = {
      hostname: 'api.netlify.com',
      path: `/api/v1/sites/${siteId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN,
        'Content-Length': Buffer.byteLength(JSON.stringify({custom_domain: domain}))
      }
    };
    const patchBody = JSON.stringify({custom_domain: domain});
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        console.log('[BUILD] Domain assign status: ' + res.statusCode);
        if (res.statusCode === 200 || res.statusCode === 201) resolve();
        else reject(new Error('Domain assign failed: ' + res.statusCode + ' ' + d.slice(0,100)));
      });
    });
    req.on('error', reject);
    req.write(patchBody);
    req.end();
  });
}

function deployToNetlify(html, slug) {
  return new Promise((resolve,reject) => {
    // Use a unique but generic site name to avoid path confusion
    const uniqueId = Math.random().toString(36).slice(2,10);
    const siteName='lunari-build-'+uniqueId;
    const cb=JSON.stringify({name:siteName});
    const co={hostname:'api.netlify.com',path:'/api/v1/sites',method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,'Content-Length':Buffer.byteLength(cb)}};
    const cr=https.request(co,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
      try{const site=JSON.parse(d);if(!site.id)return reject(new Error('Site creation failed: '+d.slice(0,200)));
      console.log('[BUILD] Site: '+site.id);
      const hb=Buffer.from(html,'utf8');
      const sha1=crypto.createHash('sha1').update(hb).digest('hex');
      const db=JSON.stringify({files:{'/index.html':sha1},draft:false});
      const dopt={hostname:'api.netlify.com',path:`/api/v1/sites/${site.id}/deploys`,method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,'Content-Length':Buffer.byteLength(db)}};
      const dr=https.request(dopt,dres=>{let dd='';dres.on('data',c=>dd+=c);dres.on('end',()=>{
        try{const deploy=JSON.parse(dd);if(!deploy.id)return reject(new Error('Deploy failed: '+dd.slice(0,200)));
        console.log('[BUILD] Deploy: '+deploy.id);
        const uo={hostname:'api.netlify.com',path:`/api/v1/deploys/${deploy.id}/files/index.html`,method:'PUT',headers:{'Content-Type':'text/html; charset=utf-8','Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,'Content-Length':hb.length}};
        const ur=https.request(uo,ures=>{let ud='';ures.on('data',c=>ud+=c);ures.on('end',()=>{
          console.log('[BUILD] Upload: '+ures.statusCode);
          const cleanName=slug.split('-').slice(0,-1).join('-')||slug;
          const customDomain=cleanName+'.lunari.pro';
          assignCustomDomain(site.id,customDomain)
            .then(()=>{console.log('[BUILD] Domain: '+customDomain);resolve({url:'https://'+customDomain,siteId:site.id});})
            .catch(e=>{console.log('[BUILD] Domain fallback: '+e.message);resolve({url:site.ssl_url||site.url||'https://'+siteName+'.netlify.app',siteId:site.id});});
        });});
        ur.on('error',reject);ur.write(hb);ur.end();
        }catch(e){reject(e);}
      });});
      dr.on('error',reject);dr.write(db);dr.end();
      }catch(e){reject(e);}
    });});
    cr.on('error',reject);cr.write(cb);cr.end();
  });
}

async function executeBuild(task,userId,siteName,jobId) {
  BUILD_RESULTS[jobId]={status:'building',message:'Claude is building your site...'};
  try{
    // Check site limit
    const limitCheck = await checkSiteLimit(userId);
    if (!limitCheck.allowed) {
      BUILD_RESULTS[jobId]={status:'limit',message:'Site limit reached',built:limitCheck.built,limit:limitCheck.limit,plan:limitCheck.plan};
      return BUILD_RESULTS[jobId];
    }
    const buildType=detectBuildType(task);
    BUILD_RESULTS[jobId].message='Generating your site with Claude Opus...';
    const html=await buildWithClaude(task,buildType,siteName);
    if(!html||html.length<1000)throw new Error('Insufficient HTML output: '+html.length+' bytes');
    BUILD_RESULTS[jobId].message='Deploying to lunari.pro...';
    const slug=generateSlug(siteName||task);
    const result=await deployToNetlify(html,slug);
    await incrementSiteCount(userId);
    BUILD_RESULTS[jobId]={status:'done',url:result.url,siteId:result.siteId,message:'Live at '+result.url,userId,builtAt:new Date().toISOString()};
    return BUILD_RESULTS[jobId];
  }catch(err){BUILD_RESULTS[jobId]={status:'error',error:err.message};throw err;}
}

// ── Claude API ───────────────────────────────────
const AGENT_SYSTEMS={nexus:'You are NEXUS, lead agent of LUNARI. Sharp co-founder energy. Strategic and direct.',prose:'You are PROSE, content agent of LUNARI. World-class writer. Full drafts only.',scout:'You are SCOUT, research agent of LUNARI. Surface non-obvious insights.',spark:'You are SPARK, marketing agent of LUNARI. Bold strategist. No hedging.'};
function callClaude(agent,prompt,apiKey){return new Promise((resolve,reject)=>{const b=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,system:AGENT_SYSTEMS[agent]||AGENT_SYSTEMS.nexus,messages:[{role:'user',content:prompt}]});const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(b)}};const r=https.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));resolve(p.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}catch(e){reject(e);}});});r.on('error',reject);r.write(b);r.end();});}

// ── Email ────────────────────────────────────────
function sendEmail(toEmail,subject,body,agentName){return new Promise((resolve)=>{const p=JSON.stringify({service_id:CONFIG.EMAILJS_SERVICE,template_id:CONFIG.EMAILJS_TEMPLATE,user_id:CONFIG.EMAILJS_KEY,template_params:{to_email:toEmail,subject,body:body.replace(/\*\*/g,'').replace(/\*/g,'').replace(/#+\s/g,''),agent:(agentName||'LUNARI').toUpperCase()}});const o={hostname:'api.emailjs.com',path:'/api/v1.0/email/send',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p),'origin':'https://lunari.pro'}};const r=https.request(o,res=>{res.on('data',()=>{});res.on('end',()=>resolve(res.statusCode===200));});r.on('error',()=>resolve(false));r.write(p);r.end();});}

// ── Schedule runner ──────────────────────────────
async function runSchedule(s){if(!s.enabled||!s.email||!CONFIG.ANTHROPIC_KEY)return;try{const r=await callClaude(s.agent,s.prompt,CONFIG.ANTHROPIC_KEY);await sendEmail(s.email,'LUNARI · '+s.name+' · '+new Date().toLocaleDateString(),r,s.agent);s.lastRun=new Date().toISOString();s.nextRun=getNextRun(s.schedule);}catch(e){console.error('[SCHEDULE]',e.message);}}
function tick(){const now=new Date();SCHEDULES.forEach(s=>{if(cronMatches(s.schedule,now))runSchedule(s);});}

// ── HTTP handler ─────────────────────────────────
function handleRequest(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const url=req.url.split('?')[0];

  if(url==='/'||url==='/health'){res.writeHead(200);return res.end(JSON.stringify({status:'online',service:'LUNARI v3',uptime:Math.floor(process.uptime())+'s',netlify:CONFIG.NETLIFY_TOKEN?'SET':'NOT SET',supabase:CONFIG.SUPABASE_URL?'SET':'NOT SET'}));}

  if(req.method==='POST'&&url==='/execute'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{task,userId,siteName}=JSON.parse(b);
        if(!task){res.writeHead(400);return res.end(JSON.stringify({error:'Missing task'}));}
        if(!CONFIG.ANTHROPIC_KEY){res.writeHead(500);return res.end(JSON.stringify({error:'No API key'}));}
        if(!CONFIG.NETLIFY_TOKEN){res.writeHead(500);return res.end(JSON.stringify({error:'No Netlify token'}));}
        const jobId=Date.now().toString();
        res.writeHead(200);res.end(JSON.stringify({ok:true,jobId,message:'Build started'}));
        executeBuild(task,userId,siteName,jobId).catch(e=>console.error('[BUILD]',e.message));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}
    });return;
  }

  if(req.method==='GET'&&url.startsWith('/execute/status/')){
    const jobId=url.split('/').pop();
    res.writeHead(200);return res.end(JSON.stringify(BUILD_RESULTS[jobId]||{status:'building',message:'Still working...'}));
  }

  if(req.method==='GET'&&url==='/schedules'){res.writeHead(200);return res.end(JSON.stringify({schedules:SCHEDULES}));}

  if(req.method==='POST'&&url==='/schedules/update'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const d=JSON.parse(b);const i=SCHEDULES.findIndex(s=>s.id===d.id);if(i>=0){SCHEDULES[i]={...SCHEDULES[i],...d};if(d.schedule)SCHEDULES[i].nextRun=getNextRun(d.schedule);res.writeHead(200);res.end(JSON.stringify({ok:true,schedule:SCHEDULES[i]}));}else{res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));}}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/run'){let b='';req.on('data',c=>b+=c);req.on('end',async()=>{try{const{id}=JSON.parse(b);const s=SCHEDULES.find(s=>s.id===id);if(!s){res.writeHead(404);return res.end(JSON.stringify({error:'Not found'}));}runSchedule(s);res.writeHead(200);res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/add'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const d=JSON.parse(b);const s={id:'s'+Date.now(),name:d.name||'New Schedule',agent:d.agent||'nexus',prompt:d.prompt||'',schedule:d.schedule||'0 8 * * *',email:d.email||'',enabled:false,lastRun:null,nextRun:getNextRun(d.schedule||'0 8 * * *')};SCHEDULES.push(s);res.writeHead(200);res.end(JSON.stringify({ok:true,schedule:s}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/delete'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const{id}=JSON.parse(b);SCHEDULES=SCHEDULES.filter(s=>s.id!==id);res.writeHead(200);res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/proxy/claude'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const pl=JSON.parse(b);const apiKey=pl.apiKey||CONFIG.ANTHROPIC_KEY;const rb=pl.body;if(!apiKey||!rb){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}const bs=JSON.stringify(rb);const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05','Content-Length':Buffer.byteLength(bs)}};const pr=https.request(o,pres=>{let d='';pres.on('data',c=>d+=c);pres.on('end',()=>{res.writeHead(pres.statusCode,{'Content-Type':'application/json'});res.end(d);});});pr.on('error',e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});pr.write(bs);pr.end();}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
}

const server=http.createServer(handleRequest);
server.listen(CONFIG.PORT,()=>{
  console.log('[LUNARI] v3 on port '+CONFIG.PORT);
  console.log('[LUNARI] Anthropic: '+(CONFIG.ANTHROPIC_KEY?'SET':'NOT SET'));
  console.log('[LUNARI] Netlify: '+(CONFIG.NETLIFY_TOKEN?'SET':'NOT SET'));
  console.log('[LUNARI] Supabase: '+(CONFIG.SUPABASE_URL?'SET':'NOT SET'));
});
setInterval(tick,60*1000);
