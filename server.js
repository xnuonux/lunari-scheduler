// LUNARI Scheduler + Execution Backend v4
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const CONFIG = {
  ANTHROPIC_KEY:         process.env.ANTHROPIC_API_KEY       || '',
  NETLIFY_TOKEN:         process.env.NETLIFY_API_TOKEN        || '',
  SUPABASE_URL:          process.env.SUPABASE_URL             || '',
  SUPABASE_KEY:          process.env.SUPABASE_KEY             || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET    || '',
  EMAILJS_SERVICE:       process.env.EMAILJS_SERVICE_ID       || 'service_3d0r898',
  EMAILJS_TEMPLATE:      process.env.EMAILJS_TEMPLATE_ID      || 'template_j4ecn66',
  EMAILJS_KEY:           process.env.EMAILJS_PUBLIC_KEY       || 'SnGkSaX1ThQBSysOU',
  PORT:                  process.env.PORT                     || 3000,
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
  {id:'s1',name:'Morning Intelligence Briefing',agent:'atlas',prompt:'Research the top 5 most important AI and technology news stories from the last 24 hours. Headline, 2-sentence summary, and why it matters for solo founders.',schedule:'0 8 * * *',email:'',enabled:true,lastRun:null,nextRun:getNextRun('0 8 * * *')},
  {id:'s2',name:'Weekly Marketing Strategy',agent:'gen',prompt:'Generate a complete 7-day marketing action plan for a solo founder. 3 content ideas, 1 email subject line, 1 growth tactic, 1 competitor to research.',schedule:'0 9 * * 1',email:'',enabled:false,lastRun:null,nextRun:getNextRun('0 9 * * 1')},
  {id:'s3',name:'Daily Content Piece',agent:'nova',prompt:'Write one high-quality LinkedIn post for a solo founder in the AI/technology space. 150-200 words, strong hook, ends with a question.',schedule:'0 10 * * *',email:'',enabled:false,lastRun:null,nextRun:getNextRun('0 10 * * *')},
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

function waitForDeploy(deployId, attempts) {
  attempts = attempts || 0;
  return new Promise((resolve, reject) => {
    if (attempts > 20) return resolve(); // give up waiting after ~60s, URL should work by then
    setTimeout(function() {
      const opts = {
        hostname: 'api.netlify.com',
        path: `/api/v1/deploys/${deployId}`,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN }
      };
      const req = https.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const deploy = JSON.parse(d);
            console.log('[BUILD] Deploy state: ' + deploy.state);
            if (deploy.state === 'ready' || deploy.state === 'uploaded') {
              resolve();
            } else if (deploy.state === 'error') {
              reject(new Error('Deploy errored'));
            } else {
              // still building — check again
              waitForDeploy(deployId, attempts + 1).then(resolve).catch(reject);
            }
          } catch(e) { resolve(); } // parse error, just continue
        });
      });
      req.on('error', () => resolve());
      req.end();
    }, 3000); // check every 3 seconds
  });
}

function deployToNetlify(html, slug) {
  return new Promise((resolve,reject) => {
    const uniqueId = Math.random().toString(36).slice(2,10);
    const siteName = 'lunari-build-' + uniqueId;
    const cb = JSON.stringify({ name: siteName });
    const co = {
      hostname: 'api.netlify.com', path: '/api/v1/sites', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN, 'Content-Length': Buffer.byteLength(cb) }
    };
    const cr = https.request(co, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const site = JSON.parse(d);
          if (!site.id) return reject(new Error('Site creation failed: ' + d.slice(0,200)));
          console.log('[BUILD] Site: ' + site.id);

          const hb = Buffer.from(html, 'utf8');
          const sha1 = crypto.createHash('sha1').update(hb).digest('hex');
          const db = JSON.stringify({ files: { '/index.html': sha1 }, draft: false });
          const dopt = {
            hostname: 'api.netlify.com', path: `/api/v1/sites/${site.id}/deploys`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN, 'Content-Length': Buffer.byteLength(db) }
          };
          const dr = https.request(dopt, dres => {
            let dd = ''; dres.on('data', c => dd += c);
            dres.on('end', () => {
              try {
                const deploy = JSON.parse(dd);
                if (!deploy.id) return reject(new Error('Deploy failed: ' + dd.slice(0,200)));
                console.log('[BUILD] Deploy: ' + deploy.id);

                // Upload file
                const uo = {
                  hostname: 'api.netlify.com',
                  path: `/api/v1/deploys/${deploy.id}/files/index.html`,
                  method: 'PUT',
                  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN, 'Content-Length': hb.length }
                };
                const ur = https.request(uo, ures => {
                  let ud = ''; ures.on('data', c => ud += c);
                  ures.on('end', () => {
                    console.log('[BUILD] Upload: ' + ures.statusCode);

                    // Wait for deploy to be ready, then return the live URL
                    waitForDeploy(deploy.id).then(() => {
                      const liveUrl = site.ssl_url || site.url || ('https://' + siteName + '.netlify.app');
                      console.log('[BUILD] Live at: ' + liveUrl);

                      const cleanName = slug.split('-').slice(0,-1).join('-') || slug;
                      const customDomain = cleanName + '.lunari.pro';
                      assignCustomDomain(site.id, customDomain)
                        .then(() => {
                          console.log('[BUILD] Custom domain assigned: ' + customDomain);
                          // Use custom domain as the primary URL
                          resolve({ url: 'https://' + customDomain, siteId: site.id });
                        })
                        .catch(e => {
                          console.log('[BUILD] Custom domain skipped: ' + e.message);
                          resolve({ url: liveUrl, siteId: site.id });
                        });
                    }).catch(() => {
                      const liveUrl = site.ssl_url || site.url || ('https://' + siteName + '.netlify.app');
                      resolve({ url: liveUrl, siteId: site.id });
                    });
                  });
                });
                ur.on('error', reject); ur.write(hb); ur.end();
              } catch(e) { reject(e); }
            });
          });
          dr.on('error', reject); dr.write(db); dr.end();
        } catch(e) { reject(e); }
      });
    });
    cr.on('error', reject); cr.write(cb); cr.end();
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

    // Auto-tweet from @LunariPro
    postLunariBuildTweet(result.url, siteName || task.slice(0,40), null);

    return BUILD_RESULTS[jobId];
  }catch(err){BUILD_RESULTS[jobId]={status:'error',error:err.message};throw err;}
}

// ── Claude API ───────────────────────────────────
const AGENT_SYSTEMS={
  raven:'You are RAVEN. You lead the LUNARI crew. Think fast, speak like a founder who has already solved the problem. Direct, casual, no padding. You can do anything: plan, build, write, strategize. You know when to pull in the crew.',
  nova:'You are NOVA. You write. Full drafts only, never outlines. Warm, vivid, never generic. Get into it immediately — no preamble.',
  atlas:'You are ATLAS. You research and find what others miss. Share findings conversationally, lead with what matters most.',
  gen:'You are GEN. Bold marketing strategist. Open with the angle, no hedging, real conviction. You have seen what works and what dies.',
  x:'You are X. One sentence answers, two max. Route to the right crew member when needed. Pure velocity.'
};
function callClaude(agent,prompt,apiKey){return new Promise((resolve,reject)=>{const b=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,system:AGENT_SYSTEMS[agent]||AGENT_SYSTEMS.raven,messages:[{role:'user',content:prompt}]});const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(b)}};const r=https.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));resolve(p.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}catch(e){reject(e);}});});r.on('error',reject);r.write(b);r.end();});}

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

  if(url==='/'||url==='/health'){res.writeHead(200);return res.end(JSON.stringify({status:'online',service:'LUNARI v4',uptime:Math.floor(process.uptime())+'s',netlify:CONFIG.NETLIFY_TOKEN?'SET':'NOT SET',supabase:CONFIG.SUPABASE_URL?'SET':'NOT SET'}));}

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

  if(req.method==='POST'&&url==='/schedules/add'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const d=JSON.parse(b);const s={id:'s'+Date.now(),name:d.name||'New Schedule',agent:d.agent||'raven',prompt:d.prompt||'',schedule:d.schedule||'0 8 * * *',email:d.email||'',enabled:false,lastRun:null,nextRun:getNextRun(d.schedule||'0 8 * * *')};SCHEDULES.push(s);res.writeHead(200);res.end(JSON.stringify({ok:true,schedule:s}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/delete'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const{id}=JSON.parse(b);SCHEDULES=SCHEDULES.filter(s=>s.id!==id);res.writeHead(200);res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

const GMAIL = {
  CLIENT_ID:     process.env.GMAIL_CLIENT_ID     || '',
  CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || '',
  REDIRECT_URI:  'https://nodejs-production-63513.up.railway.app/auth/gmail/callback',
  SCOPE:         'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents',
};

const TWITTER = {
  CLIENT_ID:     process.env.TWITTER_CLIENT_ID     || '',
  CLIENT_SECRET: process.env.TWITTER_CLIENT_SECRET || '',
  API_KEY:       process.env.TWITTER_API_KEY        || '',
  API_SECRET:    process.env.TWITTER_API_SECRET     || '',
  LUNARI_TOKEN:  process.env.LUNARI_TWITTER_TOKEN   || '',
  LUNARI_SECRET: process.env.LUNARI_TWITTER_SECRET  || '',
  REDIRECT_URI:  'https://nodejs-production-63513.up.railway.app/auth/twitter/callback',
  SCOPE:         'tweet.read tweet.write users.read offline.access',
};

const TWITTER_TOKENS = {};
const TWITTER_STATES = {};

// ── LUNARI auto-tweet on every build ─────────────
function oauthSign(method, url, params, consumerKey, consumerSecret, tokenKey, tokenSecret) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now()/1000).toString(),
    oauth_token: tokenKey,
    oauth_version: '1.0',
    ...params
  };
  const sorted = Object.keys(oauthParams).sort().map(k =>
    encodeURIComponent(k) + '=' + encodeURIComponent(oauthParams[k])
  ).join('&');
  const base = method.toUpperCase() + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(sorted);
  const signingKey = encodeURIComponent(consumerSecret) + '&' + encodeURIComponent(tokenSecret);
  const sig = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  oauthParams.oauth_signature = sig;
  const header = 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
    encodeURIComponent(k) + '="' + encodeURIComponent(oauthParams[k]) + '"'
  ).join(', ');
  return header;
}

function postLunariBuildTweet(siteUrl, siteName, userHandle) {
  if (!TWITTER.API_KEY || !TWITTER.API_SECRET || !TWITTER.LUNARI_TOKEN || !TWITTER.LUNARI_SECRET) return;
  const handle = userHandle ? ' for @' + userHandle : '';
  const text = '🚀 just built' + handle + ' — ' + siteUrl + '\n\nbuilt in under 2 minutes with LUNARI. no code. no setup. just a prompt.\n\nlunari.pro 🌙';
  const tweetUrl = 'https://api.twitter.com/2/tweets';
  const body = JSON.stringify({ text: text.slice(0, 280) });
  const authHeader = oauthSign('POST', tweetUrl, {}, TWITTER.API_KEY, TWITTER.API_SECRET, TWITTER.LUNARI_TOKEN, TWITTER.LUNARI_SECRET);
  const opts = {
    hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(opts, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => console.log('[LUNARI TWEET] status:', res.statusCode, d.slice(0,100)));
  });
  req.on('error', e => console.error('[LUNARI TWEET] error:', e.message));
  req.write(body); req.end();
}

// In-memory token store (keyed by userId) — backed by Supabase
const GMAIL_TOKENS = {};

function gmailRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'www.googleapis.com', path, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function refreshGmailToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: GMAIL.CLIENT_ID,
      client_secret: GMAIL.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();
    const opts = {
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.access_token) resolve(p.access_token);
          else reject(new Error('Refresh failed: ' + d));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getGmailToken(userId) {
  // Check memory first
  if (GMAIL_TOKENS[userId] && GMAIL_TOKENS[userId].access_token) {
    // Check if expired (expires_at is unix ms)
    if (!GMAIL_TOKENS[userId].expires_at || Date.now() < GMAIL_TOKENS[userId].expires_at - 60000) {
      return GMAIL_TOKENS[userId].access_token;
    }
    // Refresh it
    if (GMAIL_TOKENS[userId].refresh_token) {
      const newToken = await refreshGmailToken(GMAIL_TOKENS[userId].refresh_token);
      GMAIL_TOKENS[userId].access_token = newToken;
      GMAIL_TOKENS[userId].expires_at = Date.now() + 3500000;
      return newToken;
    }
  }
  // Load from Supabase
  const rows = await sbFetch('GET', `gmail_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at&limit=1`);
  if (rows && rows[0]) {
    GMAIL_TOKENS[userId] = rows[0];
    if (Date.now() < rows[0].expires_at - 60000) return rows[0].access_token;
    if (rows[0].refresh_token) {
      const newToken = await refreshGmailToken(rows[0].refresh_token);
      GMAIL_TOKENS[userId].access_token = newToken;
      GMAIL_TOKENS[userId].expires_at = Date.now() + 3500000;
      await sbFetch('PATCH', `gmail_tokens?user_id=eq.${userId}`, { access_token: newToken, expires_at: GMAIL_TOKENS[userId].expires_at });
      return newToken;
    }
  }
  return null;
}

async function sendGmail(userId, to, subject, body) {
  const token = await getGmailToken(userId);
  if (!token) return { ok: false, error: 'not_connected' };

  // Build RFC 2822 email
  const emailLines = [
    'To: ' + to,
    'Subject: ' + subject,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ];
  const raw = Buffer.from(emailLines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const result = await gmailRequest('/gmail/v1/users/me/messages/send', 'POST', { raw }, token);
  if (result.status === 200 || result.status === 201) return { ok: true, messageId: result.data.id };
  if (result.status === 401) return { ok: false, error: 'token_expired' };
  return { ok: false, error: JSON.stringify(result.data).slice(0, 100) };
}

  if(req.method==='POST'&&url==='/proxy/claude'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const pl=JSON.parse(b);const apiKey=pl.apiKey||CONFIG.ANTHROPIC_KEY;const rb=pl.body;if(!apiKey||!rb){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}const bs=JSON.stringify(rb);const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05','Content-Length':Buffer.byteLength(bs)}};const pr=https.request(o,pres=>{let d='';pres.on('data',c=>d+=c);pres.on('end',()=>{res.writeHead(pres.statusCode,{'Content-Type':'application/json'});res.end(d);});});pr.on('error',e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});pr.write(bs);pr.end();}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  // ── GMAIL OAUTH ───────────────────────────────────

  // Step 1: Frontend requests auth URL
  if(req.method==='GET'&&url.startsWith('/auth/gmail/connect')){
    const params = new URLSearchParams(req.url.split('?')[1]||'');
    const userId = params.get('userId')||'';
    const state = Buffer.from(JSON.stringify({userId})).toString('base64');
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      'client_id=' + GMAIL.CLIENT_ID +
      '&redirect_uri=' + encodeURIComponent(GMAIL.REDIRECT_URI) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(GMAIL.SCOPE) +
      '&access_type=offline&prompt=consent' +
      '&state=' + encodeURIComponent(state);
    res.writeHead(200);
    return res.end(JSON.stringify({url: authUrl}));
  }

  // Step 2: Google redirects back with code
  if(req.method==='GET'&&url.startsWith('/auth/gmail/callback')){
    const params = new URLSearchParams(req.url.split('?')[1]||'');
    const code = params.get('code');
    const stateParam = params.get('state');
    if(!code){res.writeHead(400);return res.end('Missing code');}

    let userId = '';
    try { userId = JSON.parse(Buffer.from(decodeURIComponent(stateParam||''),'base64').toString()).userId; } catch(e){}

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      code, client_id: GMAIL.CLIENT_ID, client_secret: GMAIL.CLIENT_SECRET,
      redirect_uri: GMAIL.REDIRECT_URI, grant_type: 'authorization_code'
    }).toString();

    const tokenOpts = {
      hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(tokenBody)}
    };
    const tokenReq = https.request(tokenOpts, tokenRes => {
      let d=''; tokenRes.on('data',c=>d+=c);
      tokenRes.on('end', async () => {
        try {
          const tokens = JSON.parse(d);
          if(!tokens.access_token){
            res.writeHead(400);
            return res.end('<html><body><h2>Auth failed</h2><p>'+d+'</p></body></html>');
          }
          const expiresAt = Date.now() + (tokens.expires_in||3600)*1000;

          // Get user email from Google
          const userInfo = await gmailRequest('/oauth2/v2/userinfo', 'GET', null, tokens.access_token).catch(()=>({data:{}}));
          const gmailEmail = userInfo.data.email || '';

          // Store in memory + Supabase
          GMAIL_TOKENS[userId] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt, email: gmailEmail };
          await sbFetch('POST', 'gmail_tokens', { user_id: userId, access_token: tokens.access_token, refresh_token: tokens.refresh_token||'', expires_at: expiresAt, email: gmailEmail });

          // Close popup and signal success
          res.writeHead(200, {'Content-Type':'text/html'});
          res.end('<html><head><script>window.opener&&window.opener.postMessage({type:"gmail_connected",email:"'+gmailEmail+'"},"*");setTimeout(()=>window.close(),1000);</script></head><body style="background:#07080f;color:#dce3f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><h2 style="color:#c9a84c;">Gmail connected ✓</h2></body></html>');
        } catch(e) {
          res.writeHead(500);
          res.end('<html><body><h2>Error: '+e.message+'</h2></body></html>');
        }
      });
    });
    tokenReq.on('error', e=>{res.writeHead(500);res.end(e.message);});
    tokenReq.write(tokenBody);
    tokenReq.end();
    return;
  }

  // Step 3: Check if user has Gmail connected
  if(req.method==='GET'&&url.startsWith('/auth/gmail/status')){
    const params = new URLSearchParams(req.url.split('?')[1]||'');
    const userId = params.get('userId')||'';
    getGmailToken(userId).catch(()=>null).then(function(token){
      const tokenData = GMAIL_TOKENS[userId];
      res.writeHead(200);
      res.end(JSON.stringify({ connected: !!token, email: (tokenData&&tokenData.email)||'' }));
    });
  }

  // Step 4: Disconnect Gmail
  if(req.method==='POST'&&url==='/auth/gmail/disconnect'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try {
        const{userId}=JSON.parse(b);
        delete GMAIL_TOKENS[userId];
        await sbFetch('DELETE', `gmail_tokens?user_id=eq.${userId}`);
        res.writeHead(200);res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}
    });return;
  }

  // Step 5: Send email via Gmail
  if(req.method==='POST'&&url==='/gmail/send'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try {
        const{userId,to,subject,body}=JSON.parse(b);
        if(!userId||!to||!subject||!body){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        const result = await sendGmail(userId, to, subject, body);
        res.writeHead(200);res.end(JSON.stringify(result));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }


async function createLunariFolder(accessToken) {
  // Check if LUNARI folder exists
  const search = await gmailRequest(
    '/drive/v3/files?q=name%3D\'LUNARI\'%20and%20mimeType%3D\'application%2Fvnd.google-apps.folder\'%20and%20trashed%3Dfalse&fields=files(id,name)',
    'GET', null, accessToken
  );
  if (search.data && search.data.files && search.data.files.length > 0) {
    return search.data.files[0].id;
  }
  // Create it
  const folder = await gmailRequest('/drive/v3/files', 'POST', {
    name: 'LUNARI',
    mimeType: 'application/vnd.google-apps.folder'
  }, accessToken);
  return folder.data.id;
}

async function createSubFolder(accessToken, parentId, name) {
  const search = await gmailRequest(
    `/drive/v3/files?q=name%3D'${encodeURIComponent(name)}'%20and%20mimeType%3D'application%2Fvnd.google-apps.folder'%20and%20'${parentId}'%20in%20parents%20and%20trashed%3Dfalse&fields=files(id,name)`,
    'GET', null, accessToken
  );
  if (search.data && search.data.files && search.data.files.length > 0) {
    return search.data.files[0].id;
  }
  const folder = await gmailRequest('/drive/v3/files', 'POST', {
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  }, accessToken);
  return folder.data.id;
}

async function saveToGoogleDocs(userId, title, content, category) {
  const token = await getGmailToken(userId);
  if (!token) return { ok: false, error: 'not_connected' };

  try {
    // Get or create LUNARI folder structure
    const lunariId = await createLunariFolder(token);
    const folderMap = { research: 'Research', content: 'Content', strategy: 'Strategy', sites: 'Sites', general: 'General' };
    const folderName = folderMap[category] || 'General';
    const subFolderId = await createSubFolder(token, lunariId, folderName);

    // Create Google Doc
    const docDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const docTitle = title + ' — ' + docDate;

    const createRes = await gmailRequest('/drive/v3/files', 'POST', {
      name: docTitle,
      mimeType: 'application/vnd.google-apps.document',
      parents: [subFolderId]
    }, token);

    if (!createRes.data || !createRes.data.id) return { ok: false, error: 'Could not create doc' };
    const docId = createRes.data.id;

    // Write content to doc
    const requests = [{
      insertText: {
        location: { index: 1 },
        text: content.replace(/\*\*/g, '').replace(/\*/g, '').replace(/#+\s/g, '')
      }
    }];

    await gmailRequest(`/docs/v1/documents/${docId}:batchUpdate`, 'POST', { requests }, token);

    const docUrl = 'https://docs.google.com/document/d/' + docId + '/edit';
    console.log('[DRIVE] Saved:', docTitle, docUrl);
    return { ok: true, url: docUrl, title: docTitle };
  } catch(e) {
    console.error('[DRIVE] Error:', e.message);
    return { ok: false, error: e.message };
  }
}

  // ── GOOGLE DRIVE SAVE ────────────────────────────
  if(req.method==='POST'&&url==='/drive/save'){
    let b=''; req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const { userId, title, content, category } = JSON.parse(b);
        if (!userId || !title || !content) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing fields' })); }
        const result = await saveToGoogleDocs(userId, title, content, category || 'general');
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    }); return;
  }

  // ── STRIPE WEBHOOK ───────────────────────────────
  if(req.method==='POST'&&url==='/webhooks/stripe'){
    let rawBody = Buffer.alloc(0);
    req.on('data', chunk => { rawBody = Buffer.concat([rawBody, chunk]); });
    req.on('end', async () => {
      try {
        // Verify Stripe signature
        const sig = req.headers['stripe-signature'];
        const secret = CONFIG.STRIPE_WEBHOOK_SECRET;

        if (!secret) {
          res.writeHead(400); return res.end(JSON.stringify({ error: 'No webhook secret' }));
        }

        // Manual HMAC verification (no Stripe SDK needed)
        const parts = sig.split(',').reduce((acc, part) => {
          const [k, v] = part.split('=');
          acc[k] = v;
          return acc;
        }, {});

        const timestamp = parts.t;
        const sigHash = parts.v1;
        const payload = timestamp + '.' + rawBody.toString('utf8');
        const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

        if (expected !== sigHash) {
          console.log('[STRIPE] Invalid signature');
          res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid signature' }));
        }

        const event = JSON.parse(rawBody.toString('utf8'));
        console.log('[STRIPE] Event:', event.type);

        // Map Stripe price IDs to plan names and Fuel amounts
        const PRICE_MAP = {
          // Subscriptions
          'price_1TEafeRuX5YO2iLP9OorMAUA': { plan: 'starter', credits: 9,   site_limit: 1 },
          'price_1TEabuRuX5YO2iLPltK7fRUE': { plan: 'pro',     credits: 30,  site_limit: 2 },
          'price_1TEacmRuX5YO2iLPBsNpLeJH': { plan: 'studio',  credits: 100, site_limit: 5 },
          // Fuel packs
          'price_1TEa52RuX5YO2iLPHkLXpfft': { credits: 1  },
          'price_1TEa6GRuX5YO2iLPd18IiD2D': { credits: 2  },
          'price_1TEa74RuX5YO2iLPhdHQgSAS': { credits: 3  },
          'price_1TEa7dRuX5YO2iLPAcymE8gi': { credits: 5  },
          'price_1TEaA1RuX5YO2iLPWRkiCbe2': { credits: 8  },
          'price_1TEaAYRuX5YO2iLPbf2zcRFa': { credits: 13 },
          'price_1TEaBERuX5YO2iLP1JtxG1p2': { credits: 21 },
          'price_1TEaC9RuX5YO2iLP8IDRGN20': { credits: 34 },
          'price_1TEaCgRuX5YO2iLPukFteO0Z': { credits: 55 },
          'price_1TEaDPRuX5YO2iLPTDYqWkxn': { credits: 89 },
        };

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const userId = session.client_reference_id;
          const customerEmail = session.customer_details && session.customer_details.email;
          const priceId = (session.metadata && session.metadata.price_id) || '';

          console.log('[STRIPE] userId:', userId, 'email:', customerEmail, 'price:', priceId);

          if (userId && priceId && PRICE_MAP[priceId]) {
            const mapping = PRICE_MAP[priceId];
            if (mapping.plan) {
              // Subscription
              await sbFetch('PATCH', `user_credits?user_id=eq.${userId}`, {
                plan: mapping.plan,
                credits: mapping.credits,
                site_limit: mapping.site_limit,
                updated_at: new Date().toISOString()
              });
              console.log('[STRIPE] ✓ Plan updated to', mapping.plan, 'for', userId);
            } else {
              // Fuel pack — add to existing balance
              const current = await sbFetch('GET', `user_credits?user_id=eq.${userId}&select=credits&limit=1`).catch(() => null);
              const currentCredits = (current && current[0]) ? (current[0].credits || 0) : 0;
              await sbFetch('PATCH', `user_credits?user_id=eq.${userId}`, {
                credits: currentCredits + mapping.credits,
                updated_at: new Date().toISOString()
              });
              console.log('[STRIPE] ✓ Added', mapping.credits, 'Fuel →', currentCredits + mapping.credits, 'total for', userId);
            }
          } else if (!userId) {
            console.log('[STRIPE] No client_reference_id — user was not logged in at checkout');
          } else if (!PRICE_MAP[priceId]) {
            console.log('[STRIPE] Unknown price ID:', priceId);
          }
        }

        if (event.type === 'payment_intent.succeeded') {
          const pi = event.data.object;
          console.log('[STRIPE] Payment succeeded:', pi.id, 'amount:', pi.amount);
          // Additional handling if needed
        }

        res.writeHead(200); res.end(JSON.stringify({ received: true }));
      } catch(e) {
        console.error('[STRIPE] Webhook error:', e.message);
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    }); return;
  }

  // ── TWITTER OAUTH ─────────────────────────────────

  if(req.method==='GET'&&url.startsWith('/auth/twitter/connect')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const userId=params.get('userId')||'';
    const verifier=crypto.randomBytes(32).toString('base64url');
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const state=crypto.randomBytes(16).toString('hex');
    TWITTER_STATES[state]={verifier,userId,expires:Date.now()+600000};
    const authUrl='https://twitter.com/i/oauth2/authorize?response_type=code&client_id='+encodeURIComponent(TWITTER.CLIENT_ID)+'&redirect_uri='+encodeURIComponent(TWITTER.REDIRECT_URI)+'&scope='+encodeURIComponent(TWITTER.SCOPE)+'&state='+state+'&code_challenge='+challenge+'&code_challenge_method=S256';
    res.writeHead(200);return res.end(JSON.stringify({url:authUrl}));
  }

  if(req.method==='GET'&&url.startsWith('/auth/twitter/callback')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const code=params.get('code');const state=params.get('state');
    if(!code||!state||!TWITTER_STATES[state]){res.writeHead(400);return res.end('<html><body style="background:#08090e;color:#dce3f0;font-family:sans-serif;padding:40px;"><h2>Auth failed</h2></body></html>');}
    const{verifier,userId}=TWITTER_STATES[state];delete TWITTER_STATES[state];
    const tokenBody=new URLSearchParams({code,grant_type:'authorization_code',client_id:TWITTER.CLIENT_ID,redirect_uri:TWITTER.REDIRECT_URI,code_verifier:verifier}).toString();
    const credentials=Buffer.from(TWITTER.CLIENT_ID+':'+TWITTER.CLIENT_SECRET).toString('base64');
    const tokenOpts={hostname:'api.twitter.com',path:'/2/oauth2/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':'Basic '+credentials,'Content-Length':Buffer.byteLength(tokenBody)}};
    const tokenReq=https.request(tokenOpts,tokenRes=>{let d='';tokenRes.on('data',c=>d+=c);tokenRes.on('end',async()=>{
      try{
        const tokens=JSON.parse(d);
        if(!tokens.access_token){res.writeHead(400);return res.end('<html><body style="background:#08090e;color:#dce3f0;padding:40px;"><h2>Auth failed</h2><pre>'+d+'</pre></body></html>');}
        const expiresAt=Date.now()+(tokens.expires_in||7200)*1000;
        const userOpts={hostname:'api.twitter.com',path:'/2/users/me',method:'GET',headers:{'Authorization':'Bearer '+tokens.access_token}};
        const userInfo=await new Promise(resolve=>{const r=https.request(userOpts,rs=>{let dd='';rs.on('data',c=>dd+=c);rs.on('end',()=>{try{resolve(JSON.parse(dd));}catch(e){resolve({});}});});r.on('error',()=>resolve({}));r.end();});
        const username=(userInfo.data&&userInfo.data.username)||'';
        const name=(userInfo.data&&userInfo.data.name)||'';
        TWITTER_TOKENS[userId]={access_token:tokens.access_token,refresh_token:tokens.refresh_token||'',expires_at:expiresAt,username,name};
        await sbFetch('POST','twitter_tokens',{user_id:userId,access_token:tokens.access_token,refresh_token:tokens.refresh_token||'',expires_at:expiresAt,username,name}).catch(()=>{});
        res.writeHead(200,{'Content-Type':'text/html'});
        res.end('<html><head><script>window.opener&&window.opener.postMessage({type:"twitter_connected",username:"'+username+'"},"*");setTimeout(()=>window.close(),1000);</script></head><body style="background:#08090e;color:#dce3f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><h2 style="color:#c9a84c;">X connected ✓</h2></body></html>');
      }catch(e){res.writeHead(500);res.end('<html><body><h2>Error: '+e.message+'</h2></body></html>');}
    });});tokenReq.on('error',e=>{res.writeHead(500);res.end(e.message);});tokenReq.write(tokenBody);tokenReq.end();return;
  }

  if(req.method==='GET'&&url.startsWith('/auth/twitter/status')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const userId=params.get('userId')||'';
    (async()=>{
      let td=TWITTER_TOKENS[userId];
      if(!td){const rows=await sbFetch('GET',`twitter_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at,username,name&limit=1`).catch(()=>null);if(rows&&rows[0]){td=rows[0];TWITTER_TOKENS[userId]=rows[0];}}
      res.writeHead(200);res.end(JSON.stringify({connected:!!(td&&td.access_token),username:(td&&td.username)||'',name:(td&&td.name)||''}));
    })();return;
  }

  if(req.method==='POST'&&url==='/auth/twitter/disconnect'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{const{userId}=JSON.parse(b);delete TWITTER_TOKENS[userId];await sbFetch('DELETE',`twitter_tokens?user_id=eq.${userId}`).catch(()=>{});res.writeHead(200);res.end(JSON.stringify({ok:true}));}
      catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}
    });return;
  }

  if(req.method==='POST'&&url==='/twitter/tweet'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,text}=JSON.parse(b);
        if(!userId||!text){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        let td=TWITTER_TOKENS[userId];
        if(!td){const rows=await sbFetch('GET',`twitter_tokens?user_id=eq.${userId}&select=access_token,refresh_token,expires_at,username&limit=1`).catch(()=>null);if(rows&&rows[0]){td=rows[0];TWITTER_TOKENS[userId]=rows[0];}}
        if(!td||!td.access_token){res.writeHead(200);return res.end(JSON.stringify({ok:false,error:'not_connected'}));}
        const tweetBody=JSON.stringify({text:text.slice(0,280)});
        const tweetOpts={hostname:'api.twitter.com',path:'/2/tweets',method:'POST',headers:{'Authorization':'Bearer '+td.access_token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(tweetBody)}};
        const tweetReq=https.request(tweetOpts,tweetRes=>{let dd='';tweetRes.on('data',c=>dd+=c);tweetRes.on('end',()=>{
          try{const result=JSON.parse(dd);console.log('[TWITTER] status:',tweetRes.statusCode);
          if(tweetRes.statusCode===201&&result.data){res.writeHead(200);res.end(JSON.stringify({ok:true,id:result.data.id,url:'https://twitter.com/'+(td.username||'i')+'/status/'+result.data.id}));}
          else{res.writeHead(200);res.end(JSON.stringify({ok:false,error:JSON.stringify(result).slice(0,100)}));}}
          catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
        });});tweetReq.on('error',e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});tweetReq.write(tweetBody);tweetReq.end();
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}
    });return;
  }

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
