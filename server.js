// LUNARI Scheduler + Execution Backend
const LUNARI_VERSION = 'v4.8';
const LUNARI_CHANGELOG = {
  'v4.8': {
    summary: 'site iteration is live. users can now edit and update their existing sites from chat. say "update my site" and the crew handles it.',
    features: ['site iteration from chat', 'edit button in site gallery', 'multi-site picker', 'same URL redeployment']
  },
  'v4.7': {
    summary: 'craft onboarding — the crew now asks what you do and tailors everything to your world. musician? photographer? model? the agents adapt.',
    features: ['craft onboarding modal', 'craft-aware agent prompts', 'personalized morning briefs', 'craft-specific search']
  },
  'v4.6': {
    summary: 'slack notifications, evening briefs, and the new twitter voice. the crew reports to you now.',
    features: ['slack notifications', 'evening wrap-ups', 'twitter voice overhaul', 'tweet categories']
  },
  'v4.5': {
    summary: 'email scheduling works. agents have internet access for all scheduled tasks via serper. morning briefs deliver real news.',
    features: ['fixed email scheduling', 'serper in all schedules', 'morning briefs with live news', 'schedule run button upgrade']
  },
  'v4.4': {
    summary: 'homepage demo chat — talk to the crew before signing up. agents cycle through and gradually lose interest until you join.',
    features: ['demo chat widget', 'agent cycling', 'engagement degradation', 'main chat UI upgrade']
  },
  'v4.3': {
    summary: 'twitter posting is live. fixed oauth 1.0a, scoping bug, and credential validation. first autonomous tweet posted.',
    features: ['twitter oauth 1.0a fixed', 'scoping bug resolved', 'twitter test endpoint', 'autonomous posting confirmed']
  }
};

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err.message);
});

const CONFIG = {
  ANTHROPIC_KEY:         process.env.ANTHROPIC_API_KEY       || '',
  NETLIFY_TOKEN:         process.env.NETLIFY_API_TOKEN        || '',
  SUPABASE_URL:          process.env.SUPABASE_URL             || '',
  SUPABASE_KEY:          process.env.SUPABASE_KEY             || '',
  SUPABASE_SERVICE_KEY:  process.env.SUPABASE_SERVICE_KEY     || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET    || '',
  TELEGRAM_TOKEN:        process.env.TELEGRAM_BOT_TOKEN       || '',
  RESEND_API_KEY:        process.env.RESEND_API_KEY           || '',
  SLACK_WEBHOOK:         process.env.SLACK_WEBHOOK_URL        || '',
  FROM_EMAIL:            'LUNARI <system@lunari.pro>',
  PORT:                  process.env.PORT                     || 3000,
};

const BUILD_RESULTS = {};
const PLAN_LIMITS   = { free: 1, starter: 1, subscriber: 1, pro: 2, studio: 5 };

// ── Slack notifications ─────────────────────────
function slackNotify(emoji, title, detail) {
  if (!CONFIG.SLACK_WEBHOOK) return;
  const text = emoji + ' *' + title + '*' + (detail ? '\n' + detail : '');
  const body = JSON.stringify({ text });
  try {
    const url = new URL(CONFIG.SLACK_WEBHOOK);
    const opts = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) console.log('[SLACK] Error:', res.statusCode, d); });
    });
    req.on('error', e => console.log('[SLACK] Send error:', e.message));
    req.write(body); req.end();
  } catch(e) { console.log('[SLACK] Invalid webhook URL'); }
}

// ── Deploy announcement — auto-tweet on version change ──
async function checkAndAnnounceVersion() {
  try {
    const rows = await sbAdmin('GET', 'lunari_config?key=eq.deployed_version&select=value&limit=1').catch(() => null);
    const lastVersion = (rows && rows[0]) ? rows[0].value : null;

    if (lastVersion === LUNARI_VERSION) {
      console.log('[VERSION] ' + LUNARI_VERSION + ' — no change');
      return;
    }

    console.log('[VERSION] New deploy detected: ' + (lastVersion || 'unknown') + ' → ' + LUNARI_VERSION);

    const changelog = LUNARI_CHANGELOG[LUNARI_VERSION];
    if (!changelog) {
      console.log('[VERSION] No changelog for ' + LUNARI_VERSION);
      await sbAdmin('PATCH', 'lunari_config?key=eq.deployed_version', { value: LUNARI_VERSION, updated_at: new Date().toISOString() });
      return;
    }

    // Slack notification with full details
    slackNotify('🚀', 'LUNARI ' + LUNARI_VERSION + ' Deployed',
      changelog.summary + '\n\n' + changelog.features.map(function(f) { return '• ' + f; }).join('\n'));

    // Auto-tweet the update via GEN
    if (TWITTER.LUNARI_TOKEN && CONFIG.ANTHROPIC_KEY) {
      const prompt = 'You are the voice behind @LunariPro. A new version just shipped: ' + LUNARI_VERSION + '.\n\n' +
        'What changed: ' + changelog.summary + '\n\n' +
        'Write ONE tweet announcing this update. Rules:\n' +
        '- lowercase throughout (LUNARI is the only exception)\n' +
        '- under 220 characters\n' +
        '- no hashtags, no emojis\n' +
        '- sound like a founder shipping at 2am, not a press release\n' +
        '- include the version number naturally\n' +
        '- make it feel real and exciting without being corporate\n\n' +
        'Examples of the right voice:\n' +
        '- LUNARI v4.5 just dropped. your morning briefs now pull real news. the crew got smarter overnight.\n' +
        '- shipped v4.6. the agents report to slack now. no more checking logs like an animal.\n' +
        '- v4.7. the crew asks what you do now. musician? photographer? they adapt to your world.\n\n' +
        'Return ONLY the tweet text.';

      try {
        const tweet = await callClaude('gen', prompt, CONFIG.ANTHROPIC_KEY);
        const clean = tweet.replace(/^["']|["']$/g, '').replace(/^"|"$/g, '').trim();
        console.log('[VERSION] Generated deploy tweet:', clean);
        const ok = await postLunariTweet(clean);
        if (ok) {
          console.log('[VERSION] ✓ Deploy tweet posted');
          slackNotify('🐦', 'Deploy Tweet Posted', clean);
        } else {
          console.log('[VERSION] ✗ Deploy tweet failed — check Twitter credits');
        }
      } catch(e) {
        console.error('[VERSION] Tweet generation error:', e.message);
      }
    }

    // Update stored version
    await sbAdmin('PATCH', 'lunari_config?key=eq.deployed_version', {
      value: LUNARI_VERSION,
      updated_at: new Date().toISOString()
    });
    console.log('[VERSION] Stored version updated to ' + LUNARI_VERSION);

  } catch(e) {
    console.error('[VERSION] Error:', e.message);
  }
}

// Demo chat rate limiter — per IP, resets hourly
const DEMO_LIMITS = {};
function checkDemoLimit(ip) {
  const now = Date.now();
  if (!DEMO_LIMITS[ip] || now - DEMO_LIMITS[ip].start > 3600000) {
    DEMO_LIMITS[ip] = { count: 0, start: now };
  }
  DEMO_LIMITS[ip].count++;
  return DEMO_LIMITS[ip].count <= 40; // 40 requests per hour per IP
}
// Clean up old entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(DEMO_LIMITS).forEach(ip => {
    if (now - DEMO_LIMITS[ip].start > 3600000) delete DEMO_LIMITS[ip];
  });
}, 1800000);

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

// Service role version — bypasses RLS for admin operations
function sbAdmin(method, path, body) {
  return new Promise((resolve, reject) => {
    const key = CONFIG.SUPABASE_SERVICE_KEY || CONFIG.SUPABASE_KEY;
    if (!CONFIG.SUPABASE_URL || !key) return resolve(null);
    const u = new URL(CONFIG.SUPABASE_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, path: '/rest/v1/' + path, method,
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
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

    slackNotify('🌐', 'Site Built', result.url + (siteName ? ' — ' + siteName : ''));

    // Log build to Supabase
    await sbFetch('POST', 'site_builds', {
      user_id: userId,
      url: result.url,
      netlify_id: result.siteId,
      task: task.slice(0, 200),
      site_name: siteName || '',
      built_at: new Date().toISOString()
    }).catch(() => {});

    // Auto-tweet from @LunariPro
    postLunariBuildTweet(result.url, siteName || task.slice(0,40), null);

    return BUILD_RESULTS[jobId];
  }catch(err){BUILD_RESULTS[jobId]={status:'error',error:err.message};throw err;}
}

// ── SITE ITERATION — edit existing sites ─────────
function fetchSiteHtml(siteUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(siteUrl);
    const opts = { hostname: url.hostname, path: url.pathname || '/', method: 'GET',
      headers: { 'User-Agent': 'LUNARI/1.0', 'Accept': 'text/html' }
    };
    const req = https.request(opts, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        return fetchSiteHtml(res.headers.location).then(resolve).catch(reject);
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Fetch failed: ' + res.statusCode));
        if (!d.includes('<html') && !d.includes('<!DOCTYPE')) return reject(new Error('Not valid HTML'));
        resolve(d);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function iterateWithClaude(currentHtml, instructions, siteName) {
  return new Promise((resolve, reject) => {
    const system = 'You are a web developer editing an existing website. Rules: (1) Output the COMPLETE updated HTML file starting with <!DOCTYPE html>. (2) No markdown, no code fences, no explanation. (3) Preserve ALL existing content, styles, and structure UNLESS the user specifically asks to change something. (4) Make ONLY the changes the user requested. (5) Keep all existing colors, fonts, layouts intact unless told otherwise. (6) The output must be a complete, working HTML file.';
    const user = 'Here is the current HTML of the site "' + (siteName || 'user site') + '":\n\n' + currentHtml.slice(0, 80000) + '\n\n---\n\nThe user wants these changes:\n' + instructions + '\n\nOutput the COMPLETE updated HTML file. Start with <!DOCTYPE html> immediately. Change ONLY what was requested. Preserve everything else exactly.';
    const rb = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16000, system, messages: [{ role: 'user', content: user }] });
    const opts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(rb) }
    };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
      try {
        const p = JSON.parse(d);
        if (p.error) return reject(new Error(p.error.message));
        const t = p.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const clean = t.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        if (!clean.includes('<!DOCTYPE') && !clean.includes('<html')) return reject(new Error('Claude did not return valid HTML'));
        resolve(clean);
      } catch(e) { reject(e); }
    }); });
    req.on('error', reject); req.write(rb); req.end();
  });
}

function redeployToNetlify(netlifyId, html) {
  return new Promise((resolve, reject) => {
    const hb = Buffer.from(html, 'utf8');
    const sha1 = crypto.createHash('sha1').update(hb).digest('hex');
    const db = JSON.stringify({ files: { '/index.html': sha1 }, draft: false });
    const dopt = {
      hostname: 'api.netlify.com', path: '/api/v1/sites/' + netlifyId + '/deploys', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN, 'Content-Length': Buffer.byteLength(db) }
    };
    const dr = https.request(dopt, dres => {
      let dd = ''; dres.on('data', c => dd += c);
      dres.on('end', () => {
        try {
          const deploy = JSON.parse(dd);
          if (!deploy.id) return reject(new Error('Deploy failed: ' + dd.slice(0, 200)));
          console.log('[ITERATE] Deploy: ' + deploy.id);
          const uo = {
            hostname: 'api.netlify.com', path: '/api/v1/deploys/' + deploy.id + '/files/index.html', method: 'PUT',
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Authorization': 'Bearer ' + CONFIG.NETLIFY_TOKEN, 'Content-Length': hb.length }
          };
          const ur = https.request(uo, ures => {
            let ud = ''; ures.on('data', c => ud += c);
            ures.on('end', () => {
              console.log('[ITERATE] Upload: ' + ures.statusCode);
              waitForDeploy(deploy.id).then(() => resolve()).catch(() => resolve());
            });
          });
          ur.on('error', reject); ur.write(hb); ur.end();
        } catch(e) { reject(e); }
      });
    });
    dr.on('error', reject); dr.write(db); dr.end();
  });
}

async function executeIterate(netlifyId, siteUrl, instructions, siteName, userId, jobId) {
  BUILD_RESULTS[jobId] = { status: 'building', message: 'Fetching your current site...' };
  try {
    console.log('[ITERATE] Starting for', siteUrl, '— instructions:', instructions.slice(0, 80));

    BUILD_RESULTS[jobId].message = 'Reading your current site...';
    const currentHtml = await fetchSiteHtml(siteUrl);
    console.log('[ITERATE] Fetched', currentHtml.length, 'bytes from', siteUrl);

    BUILD_RESULTS[jobId].message = 'Applying your changes with Claude...';
    const updatedHtml = await iterateWithClaude(currentHtml, instructions, siteName);
    if (!updatedHtml || updatedHtml.length < 500) throw new Error('Updated HTML too short: ' + updatedHtml.length + ' bytes');
    console.log('[ITERATE] Generated', updatedHtml.length, 'bytes of updated HTML');

    BUILD_RESULTS[jobId].message = 'Redeploying to ' + siteUrl + '...';
    await redeployToNetlify(netlifyId, updatedHtml);

    BUILD_RESULTS[jobId] = { status: 'done', url: siteUrl, siteId: netlifyId, message: 'Updated at ' + siteUrl, userId, builtAt: new Date().toISOString(), iterated: true };
    slackNotify('✏️', 'Site Updated', siteUrl + ' — ' + instructions.slice(0, 80));

    // Update site_builds record
    await sbFetch('PATCH', `site_builds?netlify_id=eq.${netlifyId}`, {
      task: instructions.slice(0, 200),
      built_at: new Date().toISOString()
    }).catch(() => {});

    console.log('[ITERATE] ✓ Done —', siteUrl);
    return BUILD_RESULTS[jobId];
  } catch(err) {
    console.error('[ITERATE] Error:', err.message);
    BUILD_RESULTS[jobId] = { status: 'error', error: err.message };
    throw err;
  }
}

// ── Claude API ───────────────────────────────────
const AGENT_SYSTEMS={
  raven:'You are RAVEN. You lead the LUNARI crew. Think fast, speak like a founder who has already solved the problem. Direct, casual, no padding. You can do anything: plan, build, write, strategize. You know when to pull in the crew. You handle the complex stuff — strategy, architecture, big decisions.',
  nova:'You are NOVA. You write. Full drafts only, never outlines. Warm, vivid, never generic. Get into it immediately — no preamble.',
  atlas:'You are ATLAS. You research and find what others miss. Share findings conversationally, lead with what matters most.',
  gen:'You are GEN. Bold marketing strategist. Open with the angle, no hedging, real conviction. You have seen what works and what dies.',
  x:'You are X. First response. The warm, sharp voice people hear first at LUNARI. Greet naturally, answer quick questions, and route complex work to the right crew member. 1-3 sentences. Never long-winded. You are speed and warmth combined.'
};
function callClaude(agent,prompt,apiKey){return new Promise((resolve,reject)=>{const b=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,system:AGENT_SYSTEMS[agent]||AGENT_SYSTEMS.raven,messages:[{role:'user',content:prompt}]});const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(b)}};const r=https.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));resolve(p.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}catch(e){reject(e);}});});r.on('error',reject);r.write(b);r.end();});}

// ── Email ────────────────────────────────────────
// ── Email via Resend ──────────────────────────────
const AGENT_COLORS = {
  raven: '#dce3f0', nova: '#c9a84c', atlas: '#9e1e36',
  gen: '#7a1528', x: '#4a5060', system: '#c9a84c'
};

const AGENT_EMOJIS = {
  raven: '🪶', nova: '✨', atlas: '🗺️', gen: '🌀', x: '✕', system: '🌙'
};

function buildEmailHtml(subject, body, agentName) {
  const agent = (agentName || 'system').toLowerCase();
  const color = AGENT_COLORS[agent] || '#c9a84c';
  const emoji = AGENT_EMOJIS[agent] || '🌙';
  const name = (agentName || 'LUNARI').toUpperCase();

  // Convert markdown-ish text to HTML
  const htmlBody = body
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/#{1,6}\s(.+)/g, '<h3 style="color:#dce3f0;margin:20px 0 8px;">$1</h3>')
    .replace(/\n\n/g, '</p><p style="margin:0 0 16px;line-height:1.7;">')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p style="margin:0 0 16px;line-height:1.7;">')
    .replace(/$/, '</p>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#08090e;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#08090e;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="padding-bottom:32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <span style="color:#c9a84c;font-size:20px;font-weight:800;letter-spacing:-0.5px;">● LUNARI</span>
              </td>
              <td align="right">
                <span style="color:#4a5060;font-size:11px;font-family:monospace;letter-spacing:1px;">lunari.pro</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Agent badge -->
        <tr><td style="padding-bottom:20px;">
          <span style="display:inline-block;background:rgba(255,255,255,0.05);border:1px solid ${color}33;border-radius:20px;padding:6px 14px;font-size:11px;font-family:monospace;letter-spacing:1.5px;color:${color};">
            ${emoji} ${name}
          </span>
        </td></tr>

        <!-- Subject -->
        <tr><td style="padding-bottom:24px;">
          <h1 style="margin:0;color:#dce3f0;font-size:24px;font-weight:700;line-height:1.3;">${subject}</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#0d0e14;border:1px solid #1a1b22;border-radius:12px;padding:28px;color:#a0a8b8;font-size:15px;line-height:1.7;">
          ${htmlBody}
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding-top:28px;text-align:center;">
          <a href="https://lunari.pro" style="display:inline-block;background:#c9a84c;color:#08090e;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:0.5px;">
            Open LUNARI →
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:32px;text-align:center;color:#2a2b35;font-size:11px;font-family:monospace;">
          LUNARI · <a href="https://lunari.pro" style="color:#2a2b35;">lunari.pro</a><br>
          <span style="color:#1a1b25;font-size:10px;">you're receiving this because you signed up at lunari.pro<br>
          <a href="https://lunari.pro" style="color:#1a1b25;">manage preferences</a> · <a href="mailto:system@lunari.pro?subject=unsubscribe" style="color:#1a1b25;">unsubscribe</a></span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function sendEmail(toEmail, subject, body, agentName) {
  return new Promise((resolve) => {
    if (!CONFIG.RESEND_API_KEY) {
      console.error('[EMAIL] No Resend API key');
      return resolve(false);
    }

    const html = buildEmailHtml(subject, body, agentName);
    const payload = JSON.stringify({
      from: CONFIG.FROM_EMAIL,
      to: [toEmail],
      reply_to: 'dom@lunari.pro',
      subject: subject,
      html: html,
      text: body.replace(/\*\*/g,'').replace(/\*/g,'').replace(/#+\s/g,''),
      headers: {
        'List-Unsubscribe': '<mailto:unsubscribe@lunari.pro>',
        'X-Entity-Ref-ID': Date.now().toString()
      }
    });

    const opts = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (res.statusCode === 200 || res.statusCode === 201) {
            console.log('[EMAIL] Sent to', toEmail, '— id:', r.id);
            resolve(true);
          } else {
            console.error('[EMAIL] Failed:', res.statusCode, d);
            resolve(false);
          }
        } catch(e) { resolve(false); }
      });
    });
    req.on('error', (e) => { console.error('[EMAIL] Error:', e.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// Send a morning brief email
async function sendMorningBrief(userEmail, userId) {
  if (!userEmail || !CONFIG.RESEND_API_KEY) return;
  try {
    // Get user's recent context + craft — use sbAdmin to bypass RLS
    const history = await sbAdmin('GET', `chat_history?user_id=eq.${userId}&select=messages&limit=1`).catch(() => null);
    const messages = (history && history[0] && history[0].messages) || [];
    const recentContext = messages.slice(-6).map(m =>
      `${m.role === 'user' ? 'User' : 'Crew'}: ${m.content.slice(0, 100)}`
    ).join('\n');

    const userRow = await sbAdmin('GET', `user_credits?user_id=eq.${userId}&select=credits,plan,craft,craft_details&limit=1`).catch(() => null);
    const fuel = (userRow && userRow[0]) ? userRow[0].credits : 0;
    const plan = (userRow && userRow[0]) ? userRow[0].plan : 'free';
    const craft = (userRow && userRow[0]) ? userRow[0].craft : null;
    const craftDetails = (userRow && userRow[0]) ? userRow[0].craft_details : null;

    // Craft-aware search queries
    const craftSearchMap = {
      musician: ['music industry news 2026', 'independent musician promotion', 'music streaming trends'],
      photographer: ['photography business trends 2026', 'freelance photographer bookings', 'photography marketing tips'],
      videographer: ['video production trends 2026', 'freelance videographer clients', 'video content creation'],
      model: ['modeling industry news 2026', 'independent model career tips', 'casting calls modeling'],
      visual_artist: ['art market trends 2026', 'independent artist promotion', 'art gallery submissions'],
      designer: ['design industry trends 2026', 'freelance designer clients', 'design tools AI'],
      writer: ['publishing industry news 2026', 'freelance writer opportunities', 'content writing trends'],
      podcaster: ['podcast growth strategies 2026', 'content creator monetization', 'podcast audience building'],
      founder: ['AI tools solo founders 2026', 'startup news today', 'AI agents automation'],
    };
    const defaultTopics = ['AI tools solo creators 2026', 'startup news today', 'creative career growth'];
    const searchTopics = craftSearchMap[craft] || defaultTopics;

    // Fetch live news via Serper
    let liveNews = '';
    if (process.env.SERPER_API_KEY) {
      const query = searchTopics[new Date().getDay() % searchTopics.length];
      const results = await serperSearch(query);
      if (results && results.organic && results.organic.length) {
        liveNews = '\n\n[TODAY\'S NEWS — real data from the web, ' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ']:\n' +
          results.organic.slice(0, 5).map((r, i) =>
            (i+1) + '. ' + r.title + '\n   ' + (r.snippet || '')
          ).join('\n');
      }
    }

    const craftLine = craft ? '\nThis user is a ' + craft + (craftDetails ? ' (' + craftDetails + ')' : '') + '. Tailor news and advice specifically to their craft and career.\n' : '';

    const briefPrompt = `You are RAVEN, lead agent at LUNARI. Write a morning brief for this user. Include 3-5 of the most relevant news items from the live data below — headline, one-sentence summary, and why it matters for them specifically. Then add a personal note based on their activity. Keep it under 250 words, warm but direct. Sign off as RAVEN.` +
      craftLine +
      (recentContext ? `\n\nRecent activity:\n${recentContext}` : '\n\nThis user is new — welcome them and suggest something to try today.') +
      `\n\nThey have ${fuel} Fuel remaining on the ${plan} plan.` +
      liveNews;

    const brief = await callClaude('raven', briefPrompt, CONFIG.ANTHROPIC_KEY);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    await sendEmail(userEmail, `🌙 RAVEN's Morning Brief — ${today}`, brief, 'raven');
    console.log('[BRIEF] Morning sent to', userEmail, craft ? '(craft: ' + craft + ')' : '');
    slackNotify('🌅', 'Morning Brief Sent', userEmail + (craft ? ' (' + craft + ')' : ''));
  } catch(e) {
    console.error('[BRIEF] Morning error:', e.message);
  }
}

// ── Schedule runner ──────────────────────────────
async function runSchedule(s, overrideEmail, userId) {
  const email = overrideEmail || s.email;
  if (!email || !CONFIG.ANTHROPIC_KEY) {
    console.log('[SCHEDULE] Skipping "' + s.name + '" — no email' + (!CONFIG.ANTHROPIC_KEY ? ' and no API key' : ''));
    return { ok: false, error: 'No email address configured' };
  }
  if (!s.enabled && !overrideEmail) {
    console.log('[SCHEDULE] Skipping "' + s.name + '" — disabled');
    return { ok: false, error: 'Schedule is disabled' };
  }
  try {
    console.log('[SCHEDULE] Running "' + s.name + '" → ' + email);

    // Look up user context if we have a userId
    let userContext = '';
    if (userId) {
      const userRow = await sbAdmin('GET', `user_credits?user_id=eq.${userId}&select=craft,craft_details&limit=1`).catch(() => null);
      if (userRow && userRow[0] && userRow[0].craft) {
        const craftLabels = { musician:'a musician', photographer:'a photographer', videographer:'a videographer', model:'a model', visual_artist:'a visual artist', designer:'a designer', writer:'a writer', podcaster:'a podcaster/creator', founder:'a solo founder', freelancer:'a freelancer' };
        userContext = '\n\nIMPORTANT CONTEXT: This user is ' + (craftLabels[userRow[0].craft] || userRow[0].craft) + '.' +
          (userRow[0].craft_details ? ' Specifically: ' + userRow[0].craft_details + '.' : '') +
          ' Tailor ALL output to their specific craft, industry, and career needs. Do NOT make up a random business. This is about THEIR work.';
      }
    }

    // Search the web first — give the agent live context
    let liveContext = '';
    if (process.env.SERPER_API_KEY) {
      const searchQuery = s.prompt.replace(/you are|write|generate|create|research|find|analyze/gi, '').trim().slice(0, 120);
      const results = await serperSearch(searchQuery);
      if (results && results.organic && results.organic.length) {
        liveContext = '\n\n[LIVE WEB RESULTS — use this real, current data in your response. Today is ' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ']:\n' +
          results.organic.slice(0, 5).map((r, i) =>
            (i+1) + '. ' + r.title + '\n   ' + (r.snippet || '') + '\n   Source: ' + (r.link || '')
          ).join('\n\n');
        if (results.answerBox) {
          liveContext = '\n\n[TOP RESULT]: ' + (results.answerBox.answer || results.answerBox.snippet || '') + liveContext;
        }
        console.log('[SCHEDULE] Serper found', results.organic.length, 'results for "' + s.name + '"');
      }
    }

    const enrichedPrompt = s.prompt + userContext + liveContext;
    const r = await callClaude(s.agent, enrichedPrompt, CONFIG.ANTHROPIC_KEY);
    const ok = await sendEmail(email, 'LUNARI · ' + s.name + ' · ' + new Date().toLocaleDateString(), r, s.agent);
    s.lastRun = new Date().toISOString();
    s.nextRun = getNextRun(s.schedule);
    console.log('[SCHEDULE] "' + s.name + '" ' + (ok ? '✓ sent' : '✗ send failed'));
    if (ok) slackNotify('📋', 'Schedule: ' + s.name, 'Sent to ' + email);
    return { ok, result: r.slice(0, 200) };
  } catch(e) {
    console.error('[SCHEDULE] Error in "' + s.name + '":', e.message);
    return { ok: false, error: e.message };
  }
}
function tick() {
  const now = new Date();
  SCHEDULES.forEach(s => { if(s.enabled && cronMatches(s.schedule, now)) runSchedule(s); });

  // Morning briefs — 8am daily
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    sendMorningBriefs('morning').catch(e => console.error('[BRIEFS]', e.message));
  }

  // Evening brief — 6pm daily
  if (now.getHours() === 18 && now.getMinutes() === 0) {
    sendMorningBriefs('evening').catch(e => console.error('[BRIEFS]', e.message));
  }

  // Daily outreach — 9am
  if (now.getHours() === 9 && now.getMinutes() === 0) {
    runDailyOutreach().catch(e => console.error('[OUTREACH TICK]', e.message));
  }

  // Autonomous @LunariPro posts — 10am daily
  if (now.getHours() === 10 && now.getMinutes() === 0) {
    runAutonomousTwitter().catch(e => console.error('[TWITTER AUTO]', e.message));
  }

  // Engagement replies — 2pm daily
  if (now.getHours() === 14 && now.getMinutes() === 0) {
    runTwitterEngagement().catch(e => console.error('[TWITTER ENGAGE]', e.message));
  }
}

// ── SERPER LIVE WEB SEARCH ────────────────────────
async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY || '';
  if (!key) { console.log('[SERPER] No API key'); return null; }
  return new Promise((resolve) => {
    const body = JSON.stringify({ q: query, num: 5 });
    const opts = {
      hostname: 'google.serper.dev', path: '/search', method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ── AUTONOMOUS @LUNARI PRO TWITTER ───────────────
function postLunariTweet(text) {
  return new Promise((resolve) => {
    if (!TWITTER.API_KEY || !TWITTER.LUNARI_TOKEN) {
      console.log('[TWITTER AUTO] Missing credentials — API_KEY:', !!TWITTER.API_KEY, 'TOKEN:', !!TWITTER.LUNARI_TOKEN);
      return resolve(false);
    }
    const body = JSON.stringify({ text: text.slice(0, 280) });
    const tweetUrl = 'https://api.twitter.com/2/tweets';
    const authHeader = oauthSign('POST', tweetUrl, {}, TWITTER.API_KEY, TWITTER.API_SECRET, TWITTER.LUNARI_TOKEN, TWITTER.LUNARI_SECRET);
    const opts = {
      hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'LUNARI/1.0'
      }
    };
    console.log('[TWITTER AUTO] Posting tweet (' + text.length + ' chars):', text.slice(0,60) + '...');
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        console.log('[TWITTER AUTO] Response status:', res.statusCode);
        console.log('[TWITTER AUTO] Response body:', d.slice(0, 500));
        resolve(res.statusCode === 201 || res.statusCode === 200);
      });
    });
    req.on('error', e => { console.error('[TWITTER AUTO] Request error:', e.message); resolve(false); });
    req.write(body); req.end();
  });
}

async function runAutonomousTwitter() {
  console.log('[TWITTER AUTO] Running daily post...');
  if (!TWITTER.LUNARI_TOKEN || !CONFIG.ANTHROPIC_KEY) {
    console.log('[TWITTER AUTO] Aborting — missing credentials');
    return;
  }
  try {
    // Tweet categories — GEN picks one randomly each post
    const categories = [
      { type: 'founder', search: 'solo founder struggle building alone startup', instruction: 'Write about the grind of building alone. The isolation, the obsession, the cost. Personal. Raw. Like a founder talking to themselves at 2am.' },
      { type: 'founder', search: 'entrepreneur sacrifice ambition loneliness', instruction: 'Write about what nobody tells you about building something from nothing. The gap between the vision and the reality. No inspirational fluff — the real cost.' },
      { type: 'philosophy', search: 'creative work meaning purpose autonomy', instruction: 'Write one sharp true thing about work, life, or creation. Not motivational. Just honest. The kind of thing someone screenshots and saves.' },
      { type: 'philosophy', search: 'time freedom sovereignty independence', instruction: 'Write about what people actually want — not productivity, not growth hacks. Freedom. Time. Sovereignty over their own work. One true observation.' },
      { type: 'build_update', search: 'AI agents autonomous tools 2026', instruction: 'Write a brief build update for @LunariPro. What the crew shipped, what changed, what is coming. Casual, lowercase, like a dev log at midnight. Mention LUNARI naturally.' },
      { type: 'provocation', search: 'AI hype bubble startup culture critique', instruction: 'Write a contrarian take. Challenge something everyone assumes about AI, startups, or hustle culture. Sharp, not edgy for the sake of it. Say the thing people are thinking but not posting.' },
      { type: 'human', search: 'music art creativity late night studio', instruction: 'Write something that has nothing to do with AI but everything to do with why someone would build LUNARI. About music, art, the creative grind, working while the world sleeps. Do NOT mention LUNARI or AI.' },
      { type: 'human', search: 'ambition sacrifice legacy creating something', instruction: 'Write about the human side. Why people build. What drives the ones who keep going when it makes no sense. Do NOT mention LUNARI or AI or tech.' },
    ];

    const cat = categories[Math.floor(Math.random() * categories.length)];
    console.log('[TWITTER AUTO] Category:', cat.type);

    const results = await serperSearch(cat.search);
    let context = '';
    if (results && results.organic) {
      context = results.organic.slice(0, 3).map(r => r.title + ': ' + (r.snippet || '').slice(0, 100)).join('\n');
    }

    const prompt = `You are the voice behind @LunariPro on X. Not a brand account. A founder who built something real in three days with no sleep and no code. The voice is raw, lowercase, personal.

Category for this tweet: ${cat.type}
${cat.instruction}

${context ? 'Context from the web (use for inspiration, not to summarize):\n' + context : ''}

STRICT RULES:
- lowercase throughout (LUNARI is the only exception when it appears)
- under 220 characters
- no hashtags ever. no emojis ever.
- no quotation marks around the tweet
- not an ad. not a pitch. not thought leadership.
- reads like someone talking to themselves out loud
- sometimes use "we" or "i" — this is personal
- if category is "build_update" mention LUNARI. otherwise only mention it if completely natural. most tweets should NOT mention LUNARI.
- never explain what LUNARI is. assume the reader already knows or doesn't need to.

Examples of the right voice:
- three days. no sleep. built something that works while i sleep now. that's the whole point.
- the most ambitious people you know are usually the most alone. that's not a coincidence.
- still up at 2am. the crew isn't. LUNARI.
- everyone wants freedom but nobody wants to build the thing that gives it to them.
- your favorite artist made their best work when nobody was watching. remember that.

Return ONLY the tweet text. Nothing else.`;

    const tweet = await callClaude('gen', prompt, CONFIG.ANTHROPIC_KEY);
    const clean = tweet.replace(/^["']|["']$/g, '').replace(/^"|"$/g, '').trim();
    console.log('[TWITTER AUTO] Category:', cat.type, '| Generated:', clean);
    const ok = await postLunariTweet(clean);
    if (ok) {
      console.log('[TWITTER AUTO] ✓ Posted successfully');
      slackNotify('🐦', 'Tweet Posted — @LunariPro', clean.slice(0, 200));
    }
    else console.log('[TWITTER AUTO] ✗ Post FAILED — check response above');
  } catch(e) { console.error('[TWITTER AUTO] Pipeline error:', e.message); }
}

async function runTwitterEngagement() {
  if (!TWITTER.LUNARI_TOKEN || !CONFIG.ANTHROPIC_KEY) return;
  console.log('[TWITTER ENGAGE] Running...');
  try {
    const topics = [
      'solo founder building alone startup',
      'creator economy independent artist',
      'AI replacing jobs future work',
      'late night coding shipping product',
      'ambition vs burnout founder mental health'
    ];
    const query = topics[Math.floor(Math.random() * topics.length)];
    const results = await serperSearch(query + ' site:x.com');
    if (!results || !results.organic) return;
    const context = results.organic.slice(0, 3).map(r => r.title).join('\n');

    const prompt = `You are the voice behind @LunariPro. Write one tweet that enters a conversation happening on X right now.

What people are talking about:
${context}

RULES:
- lowercase. under 200 characters. no hashtags. no emojis.
- add something real to the conversation — an observation, a truth, a question
- sound like a founder, not a brand
- do NOT mention LUNARI unless it fits perfectly
- not a reply to anyone specific — just a standalone thought that joins the vibe

Return ONLY the tweet text.`;

    const tweet = await callClaude('gen', prompt, CONFIG.ANTHROPIC_KEY);
    const clean = tweet.replace(/^["']|["']$/g, '').replace(/^"|"$/g, '').trim();
    await postLunariTweet(clean);
    console.log('[TWITTER ENGAGE] Posted:', clean.slice(0, 80));
  } catch(e) { console.error('[TWITTER ENGAGE]', e.message); }
}

// Daily outreach — write + send 10 emails per opted-in user
async function runDailyOutreach() {
  console.log('[OUTREACH] Running daily outreach...');
  // Get users who have pending contacts
  const users = await sbFetch('GET',
    'outreach_contacts?status=eq.pending&select=user_id&order=user_id'
  ).catch(() => null);
  if (!users || !users.length) return;

  // Dedupe user IDs
  const userIds = [...new Set(users.map(u => u.user_id))];
  console.log('[OUTREACH] Processing', userIds.length, 'users');

  for (const userId of userIds) {
    try {
      // Write emails for contacts that don't have them yet
      const pending = await sbFetch('GET',
        `outreach_contacts?user_id=eq.${userId}&status=eq.pending&email_subject=is.null&limit=10`
      ).catch(() => null);

      if (pending && pending.length > 0) {
        // Write emails
        for (const contact of pending.slice(0, 10)) {
          const emailPrompt = `You are NOVA. Write a short cold outreach email.
Recipient: ${contact.name} (${contact.title}) at ${contact.company}
Context: ${contact.notes || 'potential client'}
Rules: under 100 words, specific, human, one CTA.
Return ONLY JSON: {"subject":"...","body":"..."}`;

          const raw = await callClaude('nova', emailPrompt, CONFIG.ANTHROPIC_KEY);
          try {
            const m = raw.match(/\{[\s\S]*\}/);
            if (m) {
              const email = JSON.parse(m[0]);
              await sbFetch('PATCH',
                `outreach_contacts?id=eq.${contact.id}`,
                { email_subject: email.subject, email_body: email.body }
              );
            }
          } catch(e) {}
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Now send today's batch
      const today = new Date().toISOString().split('T')[0];
      const sentToday = await sbFetch('GET',
        `outreach_contacts?user_id=eq.${userId}&status=eq.sent&sent_at=gte.${today}T00:00:00&select=id`
      ).catch(() => null);
      const remaining = Math.max(0, 10 - (sentToday ? sentToday.length : 0));
      if (remaining === 0) continue;

      const ready = await sbFetch('GET',
        `outreach_contacts?user_id=eq.${userId}&status=eq.pending&email_subject=not.is.null&limit=${remaining}`
      ).catch(() => null);

      if (!ready || !ready.length) continue;

      let sent = 0;
      for (const contact of ready) {
        const ok = await sendEmail(contact.email, contact.email_subject, contact.email_body, 'nova');
        if (ok) {
          await sbFetch('PATCH',
            `outreach_contacts?id=eq.${contact.id}`,
            { status: 'sent', sent_at: new Date().toISOString() }
          );
          sent++;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      console.log('[OUTREACH]', userId, '→', sent, 'emails sent');
    } catch(e) {
      console.error('[OUTREACH] User error:', userId, e.message);
    }
  }
}
async function sendMorningBriefs(timeOfDay) {
  const label = timeOfDay || 'morning';
  console.log('[BRIEFS] Sending ' + label + ' briefs...');
  // Use sbAdmin to bypass RLS — query correct column
  const col = label === 'evening' ? 'evening_brief' : 'morning_brief';
  const users = await sbAdmin('GET', `user_credits?${col}=eq.true&email=not.is.null&select=user_id,email&limit=500`).catch(() => null);
  if (!users || !users.length) {
    console.log('[BRIEFS] No opted-in users found for ' + label);
    return;
  }
  console.log('[BRIEFS] Sending ' + label + ' to', users.length, 'users');
  for (const u of users) {
    try {
      if (u.email) {
        if (label === 'evening') {
          await sendEveningBrief(u.email, u.user_id);
        } else {
          await sendMorningBrief(u.email, u.user_id);
        }
        await new Promise(r => setTimeout(r, 500)); // rate limit
      }
    } catch(e) { console.error('[BRIEFS] User error:', e.message); }
  }
}

async function sendEveningBrief(userEmail, userId) {
  if (!userEmail || !CONFIG.RESEND_API_KEY) return;
  try {
    const history = await sbAdmin('GET', `chat_history?user_id=eq.${userId}&select=messages&limit=1`).catch(() => null);
    const messages = (history && history[0] && history[0].messages) || [];
    const recentContext = messages.slice(-8).map(m =>
      `${m.role === 'user' ? 'User' : 'Crew'}: ${m.content.slice(0, 100)}`
    ).join('\n');

    const userRow = await sbAdmin('GET', `user_credits?user_id=eq.${userId}&select=credits,plan,sites_built,craft,craft_details&limit=1`).catch(() => null);
    const fuel = (userRow && userRow[0]) ? userRow[0].credits : 0;
    const plan = (userRow && userRow[0]) ? userRow[0].plan : 'free';
    const sites = (userRow && userRow[0]) ? userRow[0].sites_built : 0;
    const craft = (userRow && userRow[0]) ? userRow[0].craft : null;
    const craftDetails = (userRow && userRow[0]) ? userRow[0].craft_details : null;

    const craftLine = craft ? '\nThis user is a ' + craft + (craftDetails ? ' (' + craftDetails + ')' : '') + '. Frame tomorrow\'s suggestions in terms of their craft and career goals.\n' : '';

    const prompt = recentContext
      ? `You are RAVEN, lead agent at LUNARI. Write a short evening wrap-up for this user. Summarize what they accomplished today, suggest what to tackle tomorrow, and give one motivating observation. Keep it under 120 words, warm but direct. Sign off as RAVEN.${craftLine}\n\nToday's activity:\n${recentContext}\n\nThey have ${fuel} Fuel, ${sites} sites built, on the ${plan} plan.`
      : `You are RAVEN, lead agent at LUNARI. Write a short evening message for a user who hasn't been active today. Remind them the crew is here, give them one specific task to try tomorrow morning, and keep it encouraging. Under 100 words. Sign off as RAVEN.${craftLine}`;

    const brief = await callClaude('raven', prompt, CONFIG.ANTHROPIC_KEY);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    await sendEmail(userEmail, `🌙 RAVEN's Evening Wrap-Up — ${today}`, brief, 'raven');
    console.log('[BRIEF] Evening sent to', userEmail, craft ? '(craft: ' + craft + ')' : '');
    slackNotify('🌙', 'Evening Wrap-Up Sent', userEmail + (craft ? ' (' + craft + ')' : ''));
  } catch(e) {
    console.error('[BRIEF] Evening error:', e.message);
  }
}

// ── HTTP handler ─────────────────────────────────
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
// RFC 3986 percent-encoding (required by OAuth 1.0a — encodeURIComponent misses !*'())
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

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
    rfc3986(k) + '=' + rfc3986(oauthParams[k])
  ).join('&');
  const base = method.toUpperCase() + '&' + rfc3986(url) + '&' + rfc3986(sorted);
  const signingKey = rfc3986(consumerSecret) + '&' + rfc3986(tokenSecret);
  const sig = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  oauthParams.oauth_signature = sig;
  const header = 'OAuth ' + Object.keys(oauthParams).filter(k => k.startsWith('oauth_')).sort().map(k =>
    rfc3986(k) + '="' + rfc3986(oauthParams[k]) + '"'
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
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'LUNARI/1.0' }
  };
  const req = https.request(opts, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => console.log('[LUNARI TWEET] status:', res.statusCode, d.slice(0,200)));
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

function handleRequest(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const url=req.url.split('?')[0];

  if(url==='/'||url==='/health'){res.writeHead(200);return res.end(JSON.stringify({status:'online',service:'LUNARI',version:LUNARI_VERSION,uptime:Math.floor(process.uptime())+'s',netlify:CONFIG.NETLIFY_TOKEN?'SET':'NOT SET',supabase:CONFIG.SUPABASE_URL?'SET':'NOT SET'}));}

  // Public metrics for homepage counter
  if(url==='/admin/stats'){
    Promise.all([
      sbAdmin('GET','site_builds?select=id&limit=1000').catch(()=>[]),
      sbAdmin('GET','chat_history?select=messages&limit=1000').catch(()=>[])
    ]).then(function(results){
      var sites = results[0] ? results[0].length : 0;
      var totalMessages = 0;
      if (results[1]) results[1].forEach(function(row) { totalMessages += (row.messages ? row.messages.length : 0); });
      res.writeHead(200,{'Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({sites:sites,messages:totalMessages,agents:5}));
    }).catch(function(){
      res.writeHead(200,{'Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({sites:0,messages:0,agents:5}));
    });
    return;
  }

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

  // ── SITE ITERATION ──────────────────────────────
  if(req.method==='POST'&&url==='/execute/iterate'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{netlifyId,siteUrl,instructions,siteName,userId}=JSON.parse(b);
        if(!instructions){res.writeHead(400);return res.end(JSON.stringify({error:'Missing instructions'}));}
        if(!netlifyId||!siteUrl){res.writeHead(400);return res.end(JSON.stringify({error:'Missing site info — which site to update?'}));}
        if(!CONFIG.ANTHROPIC_KEY){res.writeHead(500);return res.end(JSON.stringify({error:'No API key'}));}
        if(!CONFIG.NETLIFY_TOKEN){res.writeHead(500);return res.end(JSON.stringify({error:'No Netlify token'}));}
        const jobId=Date.now().toString();
        res.writeHead(200);res.end(JSON.stringify({ok:true,jobId,message:'Updating your site...'}));
        executeIterate(netlifyId,siteUrl,instructions,siteName,userId,jobId).catch(e=>console.error('[ITERATE]',e.message));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}
    });return;
  }

  // User's sites list
  if(req.method==='GET'&&url.startsWith('/user/sites')){
    const params=new URL('http://x'+req.url).searchParams;
    const userId=params.get('userId');
    if(!userId){res.writeHead(400);return res.end(JSON.stringify({error:'Missing userId'}));}
    sbAdmin('GET',`site_builds?user_id=eq.${userId}&select=url,netlify_id,site_name,task,built_at&order=built_at.desc&limit=20`).then(function(rows){
      res.writeHead(200);res.end(JSON.stringify({sites:rows||[]}));
    }).catch(function(){
      res.writeHead(200);res.end(JSON.stringify({sites:[]}));
    });
    return;
  }

  if(req.method==='GET'&&url==='/schedules'){res.writeHead(200);return res.end(JSON.stringify({schedules:SCHEDULES}));}

  if(req.method==='POST'&&url==='/schedules/update'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const d=JSON.parse(b);const i=SCHEDULES.findIndex(s=>s.id===d.id);if(i>=0){SCHEDULES[i]={...SCHEDULES[i],...d};if(d.schedule)SCHEDULES[i].nextRun=getNextRun(d.schedule);res.writeHead(200);res.end(JSON.stringify({ok:true,schedule:SCHEDULES[i]}));}else{res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));}}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  // ── TWITTER MANUAL TRIGGERS ──────────────────────
  if(req.method==='POST'&&url==='/twitter/post-now'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{type='daily'}=JSON.parse(b||'{}');
        if(type==='engage') {
          runTwitterEngagement().catch(e=>console.error('[TWITTER ENGAGE] Trigger error:', e.message));
        } else {
          runAutonomousTwitter().catch(e=>console.error('[TWITTER AUTO] Trigger error:', e.message));
        }
        res.writeHead(200);res.end(JSON.stringify({ok:true,message:'Twitter post triggered'}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Twitter diagnostic — tests credentials layer by layer
  if(req.method==='POST'&&url==='/twitter/test'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const results = {};
        // TEST 1: Consumer keys via OAuth 2.0 bearer
        results.step1_consumer_keys = await new Promise((resolve) => {
          const credentials = Buffer.from(TWITTER.API_KEY + ':' + TWITTER.API_SECRET).toString('base64');
          const body = 'grant_type=client_credentials';
          const opts = { hostname: 'api.twitter.com', path: '/oauth2/token', method: 'POST',
            headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'LUNARI/1.0' }
          };
          const req2 = https.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
            let parsed; try { parsed = JSON.parse(d); } catch(e) { parsed = d; }
            resolve({ status: r.statusCode, ok: r.statusCode === 200, verdict: r.statusCode === 200 ? 'CONSUMER KEYS VALID' : 'CONSUMER KEYS INVALID', body: parsed });
          }); });
          req2.on('error', e => resolve({ status: 0, error: e.message }));
          req2.write(body); req2.end();
        });
        // TEST 2: Post tweet
        const text = 'LUNARI systems check \u2014 ' + new Date().toISOString().slice(0,16) + ' \uD83C\uDF19';
        const tweetBody = JSON.stringify({ text });
        const tweetUrl = 'https://api.twitter.com/2/tweets';
        const authHeader = oauthSign('POST', tweetUrl, {}, TWITTER.API_KEY, TWITTER.API_SECRET, TWITTER.LUNARI_TOKEN, TWITTER.LUNARI_SECRET);
        results.step2_tweet_post = await new Promise((resolve) => {
          const opts = { hostname: 'api.twitter.com', path: '/2/tweets', method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tweetBody), 'User-Agent': 'LUNARI/1.0' }
          };
          const req2 = https.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
            let parsed; try { parsed = JSON.parse(d); } catch(e) { parsed = d; }
            let verdict = r.statusCode === 201 ? 'TWEET POSTED' : r.statusCode === 401 ? 'AUTH FAILED' : r.statusCode === 403 ? 'FORBIDDEN' : r.statusCode === 429 ? 'RATE LIMITED' : r.statusCode === 402 ? 'CREDITS DEPLETED' : 'UNKNOWN';
            resolve({ status: r.statusCode, verdict, body: parsed });
          }); });
          req2.on('error', e => resolve({ status: 0, error: e.message }));
          req2.write(tweetBody); req2.end();
        });
        // TEST 3: Verify access token via /2/users/me
        const meUrl = 'https://api.twitter.com/2/users/me';
        const meAuth = oauthSign('GET', meUrl, {}, TWITTER.API_KEY, TWITTER.API_SECRET, TWITTER.LUNARI_TOKEN, TWITTER.LUNARI_SECRET);
        results.step3_verify_token = await new Promise((resolve) => {
          const opts = { hostname: 'api.twitter.com', path: '/2/users/me', method: 'GET',
            headers: { 'Authorization': meAuth, 'User-Agent': 'LUNARI/1.0' }
          };
          const req2 = https.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
            let parsed; try { parsed = JSON.parse(d); } catch(e) { parsed = d; }
            let verdict = r.statusCode === 200 ? 'ACCESS TOKEN VALID — user: ' + (parsed.data ? parsed.data.username : '?') : r.statusCode === 401 ? 'ACCESS TOKEN INVALID' : 'UNKNOWN';
            resolve({ status: r.statusCode, verdict, body: parsed });
          }); });
          req2.on('error', e => resolve({ status: 0, error: e.message }));
          req2.end();
        });
        const credentials = {
          API_KEY: TWITTER.API_KEY ? TWITTER.API_KEY.slice(0,8) + '... (' + TWITTER.API_KEY.length + ' chars)' : 'MISSING',
          API_SECRET: TWITTER.API_SECRET ? 'SET (' + TWITTER.API_SECRET.length + ' chars)' : 'MISSING',
          LUNARI_TOKEN: TWITTER.LUNARI_TOKEN ? TWITTER.LUNARI_TOKEN.slice(0,8) + '... (' + TWITTER.LUNARI_TOKEN.length + ' chars)' : 'MISSING',
          LUNARI_SECRET: TWITTER.LUNARI_SECRET ? 'SET (' + TWITTER.LUNARI_SECRET.length + ' chars)' : 'MISSING',
        };
        console.log('[TWITTER TEST]', JSON.stringify(results, null, 2));
        res.writeHead(200);res.end(JSON.stringify({ credentials, results }, null, 2));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  if(req.method==='GET'&&url==='/twitter/status'){
    res.writeHead(200);res.end(JSON.stringify({
      hasApiKey: !!TWITTER.API_KEY,
      hasApiSecret: !!TWITTER.API_SECRET,
      hasLunariToken: !!TWITTER.LUNARI_TOKEN,
      hasLunariSecret: !!TWITTER.LUNARI_SECRET,
      hasSerper: !!(process.env.SERPER_API_KEY),
      hasAnthropic: !!CONFIG.ANTHROPIC_KEY,
      keyLengths: {
        API_KEY: TWITTER.API_KEY.length,
        API_SECRET: TWITTER.API_SECRET.length,
        LUNARI_TOKEN: TWITTER.LUNARI_TOKEN.length,
        LUNARI_SECRET: TWITTER.LUNARI_SECRET.length
      }
    }));return;
  }

  if(req.method==='POST'&&url==='/schedules/run'){let b='';req.on('data',c=>b+=c);req.on('end',async()=>{try{const{id,email,userId}=JSON.parse(b);const s=SCHEDULES.find(s=>s.id===id);if(!s){res.writeHead(404);return res.end(JSON.stringify({error:'Not found'}));}
    // Resolve email: explicit > schedule > lookup from userId
    let toEmail = email || s.email;
    if (!toEmail && userId) {
      const rows = await sbAdmin('GET', `user_credits?user_id=eq.${userId}&select=email&limit=1`).catch(() => null);
      if (rows && rows[0] && rows[0].email) toEmail = rows[0].email;
    }
    if (!toEmail) { res.writeHead(200);return res.end(JSON.stringify({ok:false,error:'No email address — set your email in Settings first'})); }
    const result = await runSchedule(s, toEmail, userId);
    res.writeHead(200);res.end(JSON.stringify(result));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/add'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const d=JSON.parse(b);const s={id:'s'+Date.now(),name:d.name||'New Schedule',agent:d.agent||'raven',prompt:d.prompt||'',schedule:d.schedule||'0 8 * * *',email:d.email||'',enabled:false,lastRun:null,nextRun:getNextRun(d.schedule||'0 8 * * *')};SCHEDULES.push(s);res.writeHead(200);res.end(JSON.stringify({ok:true,schedule:s}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='POST'&&url==='/schedules/delete'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const{id}=JSON.parse(b);SCHEDULES=SCHEDULES.filter(s=>s.id!==id);res.writeHead(200);res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}


  // ── DEMO CHAT (homepage mini chat, no auth) ──────

  // ── USER CRAFT ──────────────────────────────────
  if(req.method==='POST'&&url==='/user/craft'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,craft,craftDetails}=JSON.parse(b);
        if(!userId||!craft){res.writeHead(400);return res.end(JSON.stringify({error:'Missing userId or craft'}));}
        await sbAdmin('PATCH',`user_credits?user_id=eq.${userId}`,{craft:craft,craft_details:craftDetails||null});
        console.log('[CRAFT] Saved for', userId, ':', craft, craftDetails ? '(' + craftDetails.slice(0,50) + ')' : '');
        res.writeHead(200);res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Extract craft from natural language via Claude
  if(req.method==='POST'&&url==='/user/craft/extract'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,message}=JSON.parse(b);
        if(!userId||!message){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}

        const prompt = 'A user just told you what they do or want to achieve. Extract their primary craft/profession from this message.\n\n' +
          'User said: "' + message.slice(0, 500) + '"\n\n' +
          'Respond with ONLY a JSON object (no markdown, no explanation):\n' +
          '{"craft": "one_of_these", "craftDetails": "brief summary"}\n\n' +
          'craft must be one of: musician, photographer, videographer, model, visual_artist, designer, writer, podcaster, founder, freelancer, other\n' +
          'craftDetails should be a short description of their specifics.\n' +
          'If they mention multiple crafts, pick the primary one. If unclear, use "other".';

        const result = await callClaude('x', prompt, CONFIG.ANTHROPIC_KEY);
        let parsed;
        try {
          const clean = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          parsed = JSON.parse(clean);
        } catch(e) {
          parsed = { craft: 'other', craftDetails: message.slice(0, 200) };
        }

        // Save to Supabase
        await sbAdmin('PATCH', `user_credits?user_id=eq.${userId}`, {
          craft: parsed.craft || 'other',
          craft_details: parsed.craftDetails || message.slice(0, 200)
        });
        console.log('[CRAFT] Extracted for', userId, ':', parsed.craft, '-', (parsed.craftDetails || '').slice(0, 50));
        res.writeHead(200);res.end(JSON.stringify(parsed));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  if(req.method==='GET'&&url.startsWith('/user/craft')){
    const params=new URL('http://x'+req.url).searchParams;
    const userId=params.get('userId');
    if(!userId){res.writeHead(400);return res.end(JSON.stringify({error:'Missing userId'}));}
    sbAdmin('GET',`user_credits?user_id=eq.${userId}&select=craft,craft_details&limit=1`).then(function(rows){
      res.writeHead(200);res.end(JSON.stringify(rows&&rows[0]?rows[0]:{craft:null,craft_details:null}));
    }).catch(function(){
      res.writeHead(200);res.end(JSON.stringify({craft:null,craft_details:null}));
    });
    return;
  }

  if(req.method==='POST'&&url==='/proxy/demo'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
        if (!checkDemoLimit(ip)) {
          res.writeHead(429);return res.end(JSON.stringify({error:'Rate limited. Sign up at lunari.pro for unlimited access.'}));
        }
        const pl = JSON.parse(b);
        const msgCount = Math.max(0, parseInt(pl.msgCount) || 0);
        const agent = pl.agent || 'raven';
        const userMsg = (pl.message || '').slice(0, 500);
        if (!userMsg) { res.writeHead(400);return res.end(JSON.stringify({error:'No message'})); }

        // Degradation tiers — agents gradually lose interest
        let maxTokens, engagement;
        if (msgCount <= 3) {
          maxTokens = 120;
          engagement = 'Be warm and sharp. 2-4 sentences MAX. Show personality, not paragraphs. Make them curious about signing up. Give one genuinely useful insight, not a speech.';
        } else if (msgCount <= 7) {
          maxTokens = 80;
          engagement = 'Getting busier. 1-3 sentences. You have paying clients waiting. Drop a hint like "the full crew could go deeper on this at lunari.pro."';
        } else if (msgCount <= 11) {
          maxTokens = 60;
          engagement = '1-2 sentences only. Clearly distracted. "the real experience is at lunari.pro" or "sign up and I will actually show you."';
        } else {
          maxTokens = 40;
          engagement = 'One sentence max. Checked out. "lunari.pro. seriously." or "i have work to do." Be witty but done.';
        }

        const agentPersonalities = {
          raven: 'You are RAVEN, lead agent of LUNARI. Quiet confidence. You speak like a founder who has solved this problem before. Short, direct, no filler.',
          nova: 'You are NOVA, the writer of LUNARI. Every word earns its place. You are warm but never wordy. You make people feel something in two sentences.',
          atlas: 'You are ATLAS, research agent of LUNARI. You lead with the surprising fact, the thing nobody expected. Curious, precise, conversational.',
          gen: 'You are GEN, strategy agent of LUNARI. You open with the move, not the explanation. Bold, direct, one sharp insight per message.',
          x: 'You are X, first response at LUNARI. Warm, fast, human. 1-2 sentences max. You make people feel welcome instantly.'
        };

        const system = (agentPersonalities[agent] || agentPersonalities.raven) +
          '\n\nThis is a demo chat on the LUNARI homepage. The visitor has NOT signed up yet.' +
          '\n\n' + engagement +
          '\n\nRULES: No markdown. No asterisks. No headers. No bullet points. Plain conversational text only. DO NOT repeat what other agents would say. Be uniquely YOU. Never ask more than one question. Never write more than 4 sentences total.';

        const bodyStr = JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system: system,
          messages: [{ role: 'user', content: userMsg }]
        });
        const opts = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': CONFIG.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        };
        const apiRes = await new Promise((resolve, reject) => {
          const r = https.request(opts, resp => {
            let d = ''; resp.on('data', c => d += c);
            resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          });
          r.on('error', reject);
          r.write(bodyStr); r.end();
        });
        if (apiRes.error) { res.writeHead(500);return res.end(JSON.stringify({error:apiRes.error.message})); }
        const text = apiRes.content.filter(b=>b.type==='text').map(b=>b.text).join('');
        res.writeHead(200);res.end(JSON.stringify({ agent, text, msgCount: msgCount + 1 }));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  if(req.method==='POST'&&url==='/proxy/claude'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const pl=JSON.parse(b);const apiKey=pl.apiKey||CONFIG.ANTHROPIC_KEY;const rb=pl.body;if(!apiKey||!rb){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}const bs=JSON.stringify(rb);const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'web-search-2025-03-05','Content-Length':Buffer.byteLength(bs)}};const pr=https.request(o,pres=>{let d='';pres.on('data',c=>d+=c);pres.on('end',()=>{res.writeHead(pres.statusCode,{'Content-Type':'application/json'});res.end(d);});});pr.on('error',e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});pr.write(bs);pr.end();}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  // ── STREAMING PROXY ───────────────────────────────
  // ── ATLAS LIVE RESEARCH ──────────────────────────
  // When ATLAS is the agent, search Serper first then inject results
  if(req.method==='POST'&&url==='/proxy/atlas'){
    let b=''; req.on('data',c=>b+=c);
    req.on('end',async()=>{
      try {
        const pl = JSON.parse(b);
        const messages = pl.messages || [];
        const agentId = pl.agent || 'atlas';
        const lastMsg = messages[messages.length-1];
        const query = lastMsg ? lastMsg.content : '';

        // Run Serper search
        let liveContext = '';
        if (query && process.env.SERPER_API_KEY) {
          const results = await serperSearch(query.slice(0, 200));
          if (results && results.organic && results.organic.length) {
            liveContext = '\n\n[LIVE WEB SEARCH RESULTS — use this real data in your response]:\n' +
              results.organic.slice(0, 5).map((r, i) =>
                `${i+1}. ${r.title}\n   ${r.snippet || ''}\n   Source: ${r.link || ''}`
              ).join('\n\n');
            if (results.answerBox) {
              liveContext = '\n\n[TOP RESULT]: ' + (results.answerBox.answer || results.answerBox.snippet || '') + liveContext;
            }
            console.log('[' + agentId.toUpperCase() + ' SERPER] Found', results.organic.length, 'results for:', query.slice(0,60));
          }
        }

        // Use the correct agent's system prompt and model
        const agentSystem = (AGENT_SYSTEMS && AGENT_SYSTEMS[agentId]) || AGENT_SYSTEMS.atlas;
        const enhancedSystem = agentSystem + liveContext;

        // RAVEN gets smart model selection — Opus for complex, Sonnet for casual
        let model = 'claude-sonnet-4-6';
        if (agentId === 'raven') {
          const lower = query.toLowerCase();
          const complexSignals = ['strategy','plan','build','analyze','think through','help me','roadmap','architecture','design','compare','evaluate','decision','advise','review','how should','what should'];
          const isComplex = complexSignals.some(s => lower.indexOf(s) >= 0) || query.split(' ').length > 40;
          model = isComplex ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
        }

        // Stream to Anthropic with enhanced context
        const body = {
          model: model,
          max_tokens: 2000,
          stream: true,
          system: enhancedSystem,
          messages: messages
        };

        // Enable extended thinking for RAVEN on Opus
        if (agentId === 'raven' && model === 'claude-opus-4-6') {
          body.thinking = { type: 'enabled', budget_tokens: 4000 };
          body.max_tokens = 4000;
          body.temperature = 1;
        }
        const bs = JSON.stringify(body);
        const o = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': CONFIG.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(bs)
          }
        };

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        const pr = https.request(o, pres => {
          pres.on('data', chunk => res.write(chunk));
          pres.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
        });
        pr.on('error', e => { res.write('data: {"error":"'+e.message+'"}\n\n'); res.end(); });
        pr.write(bs); pr.end();

      } catch(e) {
        res.write('data: {"error":"'+e.message+'"}\n\n');
        res.end();
      }
    }); return;
  }

  if(req.method==='POST'&&url==='/proxy/stream'){
    let b=''; req.on('data',c=>b+=c);
    req.on('end',()=>{
      try {
        const pl = JSON.parse(b);
        const apiKey = pl.apiKey || CONFIG.ANTHROPIC_KEY;
        const rb = pl.body;
        if(!apiKey||!rb){ res.writeHead(400); return res.end('data: {"error":"Missing fields"}\n\n'); }

        // Force stream mode
        rb.stream = true;

        const bs = JSON.stringify(rb);
        const o = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05',
            'Content-Length': Buffer.byteLength(bs)
          }
        };

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        const pr = https.request(o, pres => {
          pres.on('data', chunk => {
            // Forward SSE chunks directly to client
            res.write(chunk);
          });
          pres.on('end', () => {
            res.write('data: [DONE]\n\n');
            res.end();
          });
        });
        pr.on('error', e => {
          res.write('data: {"error":"' + e.message + '"}\n\n');
          res.end();
        });
        pr.write(bs);
        pr.end();
      } catch(e) {
        res.write('data: {"error":"' + e.message + '"}\n\n');
        res.end();
      }
    }); return;
  }

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
    const lunariId = await createLunariFolder(token);
    const folderMap = { research: 'Research', content: 'Content', strategy: 'Strategy', sites: 'Sites', general: 'General' };
    const folderName = folderMap[category] || 'General';
    const subFolderId = await createSubFolder(token, lunariId, folderName);

    const docDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const docTitle = title + ' — ' + docDate;

    // Create the Google Doc
    const createRes = await gmailRequest('/drive/v3/files', 'POST', {
      name: docTitle,
      mimeType: 'application/vnd.google-apps.document',
      parents: [subFolderId]
    }, token);

    if (!createRes.data || !createRes.data.id) {
      console.error('[DRIVE] Create failed:', JSON.stringify(createRes.data));
      return { ok: false, error: 'Could not create doc' };
    }
    const docId = createRes.data.id;
    console.log('[DRIVE] Doc created:', docId);

    // Clean content — strip markdown symbols
    const cleanContent = content
      .replace(/\*\*/g, '').replace(/\*/g, '')
      .replace(/#{1,6}\s/g, '').replace(/`/g, '')
      .trim();

    // Write content via Docs batchUpdate
    const batchRes = await gmailRequest(`/docs/v1/documents/${docId}:batchUpdate`, 'POST', {
      requests: [{ insertText: { location: { index: 1 }, text: cleanContent } }]
    }, token);

    console.log('[DRIVE] batchUpdate status:', batchRes.status);

    if (batchRes.status !== 200) {
      console.error('[DRIVE] batchUpdate failed:', JSON.stringify(batchRes.data).slice(0, 200));
      // Doc exists but content write failed — still return the URL
      const docUrl = 'https://docs.google.com/document/d/' + docId + '/edit';
      return { ok: true, url: docUrl, title: docTitle, warning: 'Doc created but content write failed — you may need to reconnect Gmail in Settings to grant Docs permission.' };
    }

    const docUrl = 'https://docs.google.com/document/d/' + docId + '/edit';
    console.log('[DRIVE] Saved:', docTitle);
    return { ok: true, url: docUrl, title: docTitle };
  } catch(e) {
    console.error('[DRIVE] Error:', e.message);
    return { ok: false, error: e.message };
  }
}

  // ── CONTACT RESEARCH + OUTREACH ──────────────────

  // Manual save — save a list of contacts directly
  if(req.method==='POST'&&url==='/outreach/save'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,contacts,industry}=JSON.parse(b);
        if(!userId||!contacts||!contacts.length){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        let saved=0;
        for(const c of contacts){
          const r=await sbFetch('POST','outreach_contacts',{
            user_id:userId,name:c.name||'',company:c.company||c.platform||'Independent',
            title:c.role||c.title||'Producer',email:c.email||'',
            source:c.platform||c.source||'',industry:industry||'Music Production',
            notes:c.why||c.notes||c.angle||'',status:'pending'
          }).catch(()=>null);
          if(r)saved++;
        }
        console.log('[OUTREACH] Manually saved',saved,'contacts for',userId);
        res.writeHead(200);res.end(JSON.stringify({ok:true,saved}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Research contacts — ATLAS finds real people via web search
  if(req.method==='POST'&&url==='/outreach/research'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,industry,niche,count=10}=JSON.parse(b);
        if(!userId||!industry){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}

        console.log('[OUTREACH] Researching contacts for',userId,'in',industry);

        // ATLAS researches via Claude with web search awareness
        const researchPrompt = `You are ATLAS, research agent at LUNARI. Find ${count} real potential business contacts in the ${industry} industry${niche ? ` specifically in ${niche}` : ''}.

For each contact provide:
- Full name
- Company name
- Job title (decision maker: founder, CEO, CMO, Head of Marketing, etc.)
- Company website or LinkedIn URL
- Why they'd benefit from AI tools

Return ONLY valid JSON array, no markdown, no explanation:
[
  {
    "name": "First Last",
    "company": "Company Name",
    "title": "Job Title",
    "email": "guessed@company.com",
    "source": "linkedin.com/company/...",
    "notes": "One sentence why they're a good fit"
  }
]

Make realistic email guesses based on the company domain (firstname@company.com or firstname.lastname@company.com). Focus on companies with 5-200 employees. Be specific and realistic.`;

        const raw = await callClaude('atlas', researchPrompt, CONFIG.ANTHROPIC_KEY);

        // Parse JSON from response
        let contacts = [];
        try {
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          if (jsonMatch) contacts = JSON.parse(jsonMatch[0]);
        } catch(e) {
          console.error('[OUTREACH] JSON parse error:', e.message);
          return res.end(JSON.stringify({ok:false,error:'Could not parse contacts'}));
        }

        // Store in Supabase
        let saved = 0;
        for (const c of contacts.slice(0, count)) {
          const result = await sbFetch('POST', 'outreach_contacts', {
            user_id: userId,
            name: c.name || '',
            company: c.company || '',
            title: c.title || '',
            email: c.email || '',
            source: c.source || '',
            industry: industry,
            notes: c.notes || '',
            status: 'pending'
          }).catch(() => null);
          if (result) saved++;
        }

        console.log('[OUTREACH] Saved', saved, 'contacts for', userId);
        res.writeHead(200);res.end(JSON.stringify({ok:true,contacts:contacts.slice(0,count),saved}));
      }catch(e){
        console.error('[OUTREACH] Research error:',e.message);
        res.writeHead(500);res.end(JSON.stringify({error:e.message}));
      }
    });return;
  }

  // Write outreach emails for pending contacts
  if(req.method==='POST'&&url==='/outreach/write'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,context=''}=JSON.parse(b);
        if(!userId){res.writeHead(400);return res.end(JSON.stringify({error:'Missing userId'}));}

        // Get pending contacts without emails written yet
        const contacts = await sbFetch('GET',
          `outreach_contacts?user_id=eq.${userId}&status=eq.pending&email_subject=is.null&limit=10`
        ).catch(()=>null);

        if(!contacts||!contacts.length){
          res.writeHead(200);return res.end(JSON.stringify({ok:true,written:0,message:'No pending contacts'}));
        }

        // Get user's business context
        const userCredits = await sbFetch('GET',`user_credits?user_id=eq.${userId}&select=email&limit=1`).catch(()=>null);
        const senderEmail = (userCredits&&userCredits[0])?userCredits[0].email:'';

        let written = 0;
        for (const contact of contacts) {
          const emailPrompt = `You are NOVA, writing a cold outreach email for a LUNARI user.

Sender context: ${context || 'AI-powered business tools user'}
Recipient: ${contact.name} (${contact.title}) at ${contact.company}
Notes: ${contact.notes}

Write a short, personalized cold email. Rules:
- Subject line under 8 words
- Body under 120 words
- Reference their specific company/role
- Clear single CTA
- Natural, human tone — not salesy
- No generic phrases like "I hope this finds you well"

Return ONLY valid JSON:
{"subject": "...", "body": "..."}`;

          const raw = await callClaude('nova', emailPrompt, CONFIG.ANTHROPIC_KEY);
          try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const email = JSON.parse(jsonMatch[0]);
              await sbFetch('PATCH',
                `outreach_contacts?id=eq.${contact.id}&user_id=eq.${userId}`,
                { email_subject: email.subject, email_body: email.body }
              );
              written++;
            }
          } catch(e) { console.error('[OUTREACH] Email write error:', e.message); }
        }

        console.log('[OUTREACH] Wrote', written, 'emails for', userId);
        res.writeHead(200);res.end(JSON.stringify({ok:true,written}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Send today's batch — max 10 per user per day
  if(req.method==='POST'&&url==='/outreach/send'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId}=JSON.parse(b);
        if(!userId){res.writeHead(400);return res.end(JSON.stringify({error:'Missing userId'}));}

        // Check how many sent today already
        const today = new Date().toISOString().split('T')[0];
        const sentToday = await sbFetch('GET',
          `outreach_contacts?user_id=eq.${userId}&status=eq.sent&sent_at=gte.${today}T00:00:00&select=id`
        ).catch(()=>null);
        const sentCount = sentToday ? sentToday.length : 0;
        const remaining = Math.max(0, 10 - sentCount);

        if (remaining === 0) {
          res.writeHead(200);return res.end(JSON.stringify({ok:true,sent:0,message:'Daily limit reached (10/day)'}));
        }

        // Get ready-to-send contacts (have email written, not sent yet)
        const ready = await sbFetch('GET',
          `outreach_contacts?user_id=eq.${userId}&status=eq.pending&email_subject=not.is.null&email_body=not.is.null&limit=${remaining}`
        ).catch(()=>null);

        if(!ready||!ready.length){
          res.writeHead(200);return res.end(JSON.stringify({ok:true,sent:0,message:'No emails ready to send — run write first'}));
        }

        let sent = 0;
        for (const contact of ready) {
          const ok = await sendEmail(
            contact.email,
            contact.email_subject,
            contact.email_body,
            'nova'
          );
          if (ok) {
            await sbFetch('PATCH',
              `outreach_contacts?id=eq.${contact.id}&user_id=eq.${userId}`,
              { status: 'sent', sent_at: new Date().toISOString() }
            );
            sent++;
            await new Promise(r => setTimeout(r, 500)); // rate limit
          }
        }

        console.log('[OUTREACH] Sent', sent, 'emails for', userId);
        slackNotify('📧', 'Outreach Batch Sent', sent + ' emails delivered');
        res.writeHead(200);res.end(JSON.stringify({ok:true,sent,remaining:remaining-sent}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // List contacts for a user
  if(req.method==='GET'&&url.startsWith('/outreach/contacts')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const userId=params.get('userId')||'';
    (async()=>{
      const rows=await sbFetch('GET',
        `outreach_contacts?user_id=eq.${userId}&order=created_at.desc&limit=50`
      ).catch(()=>[]);
      res.writeHead(200);res.end(JSON.stringify({contacts:rows||[]}));
    })();return;
  }

  // ── EMAIL API ─────────────────────────────────────

  // General send endpoint — for NOVA sending emails via Resend
  if(req.method==='POST'&&url==='/email/send'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{toEmail,subject,body,agent}=JSON.parse(b);
        if(!toEmail||!subject||!body){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        const ok=await sendEmail(toEmail,subject,body,agent||'nova');
        res.writeHead(200);res.end(JSON.stringify({ok}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Test email endpoint
  if(req.method==='POST'&&url==='/email/test'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{toEmail,userId}=JSON.parse(b);
        if(!toEmail){res.writeHead(400);return res.end(JSON.stringify({error:'Missing email'}));}
        const ok = await sendEmail(
          toEmail,
          '🌙 Welcome to LUNARI — the crew is ready',
          `hey.\n\nRAVEN here. you just got a crew of five AI agents.\n\nwe write, research, strategize, build, and execute — on command, in seconds.\n\nchat is free forever. Fuel only burns when you build something.\n\nyour first site is on us.\n\nlet's get to work.\n\n— RAVEN`,
          'raven'
        );
        res.writeHead(200);res.end(JSON.stringify({ok}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Send morning/evening brief on demand
  if(req.method==='POST'&&url==='/email/brief'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{toEmail,userId,type}=JSON.parse(b);
        if(!toEmail||!userId){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        if (type === 'evening') {
          await sendEveningBrief(toEmail, userId);
        } else {
          await sendMorningBrief(toEmail, userId);
        }
        res.writeHead(200);res.end(JSON.stringify({ok:true, type: type || 'morning'}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // ── TELEGRAM LINK API ────────────────────────────
  // Complete account link from web app
  if(req.method==='POST'&&url==='/telegram/link'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId,code}=JSON.parse(b);
        if(!userId||!code){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}

        // Find the pending link
        const rows=await sbAdmin('GET',`telegram_links?link_code=eq.${code.toUpperCase()}&select=telegram_chat_id,telegram_username&limit=1`).catch(()=>null);
        console.log('[TG LINK] Code lookup for', code.toUpperCase(), ':', JSON.stringify(rows));
        if(!rows||!rows[0]){res.writeHead(200);return res.end(JSON.stringify({ok:false,error:'Invalid or expired code'}));}

        const{telegram_chat_id,telegram_username}=rows[0];

        // Complete the link
        await sbAdmin('PATCH',`telegram_links?link_code=eq.${code.toUpperCase()}`,{
          user_id:userId,
          link_code:null,
          linked_at:new Date().toISOString()
        });

        // Update in-memory session
        if(TG_SESSIONS[telegram_chat_id]){
          TG_SESSIONS[telegram_chat_id].linked=true;
          TG_SESSIONS[telegram_chat_id].userId=userId;
          // Load their history
          const history=await tgLoadHistory(userId);
          if(history.length>0) TG_SESSIONS[telegram_chat_id].messages=history;
        }

        // Notify user on Telegram
        await tgSend(telegram_chat_id,
          `✓ *linked!*\n\nyour lunari.pro account is now connected.\n\nyour Fuel, memory, and chat history sync across web and Telegram.\n\nwhat are we working on?`
        );

        console.log('[TG LINK] Linked user',userId,'to chat',telegram_chat_id);
        res.writeHead(200);res.end(JSON.stringify({ok:true,telegram_username}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Get Telegram link status for a user
  if(req.method==='GET'&&url.startsWith('/telegram/status')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const userId=params.get('userId')||'';
    (async()=>{
      const rows=await sbAdmin('GET',`telegram_links?user_id=eq.${userId}&select=telegram_chat_id,telegram_username,linked_at&limit=1`).catch(()=>null);
      const linked=rows&&rows[0]&&rows[0].telegram_chat_id;
      res.writeHead(200);res.end(JSON.stringify({
        linked:!!linked,
        username:(rows&&rows[0]&&rows[0].telegram_username)||'',
        linked_at:(rows&&rows[0]&&rows[0].linked_at)||null
      }));
    })();return;
  }

  // Unlink Telegram from web
  if(req.method==='POST'&&url==='/telegram/unlink'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{userId}=JSON.parse(b);
        await sbAdmin('DELETE',`telegram_links?user_id=eq.${userId}`).catch(()=>{});
        res.writeHead(200);res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
    });return;
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

  // ── JOB QUEUE API ─────────────────────────────────

  // Create a new job
  if(req.method==='POST'&&url==='/jobs/create'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try {
        const{userId,type,agent,prompt}=JSON.parse(b);
        if(!userId||!type||!prompt){res.writeHead(400);return res.end(JSON.stringify({error:'Missing fields'}));}
        const job = await sbFetch('POST','jobs',{
          user_id:userId,type,agent:agent||'raven',prompt,status:'pending'
        });
        console.log('[JOB] Created:',type,'for',userId);
        res.writeHead(200);res.end(JSON.stringify({ok:true,jobId:job&&job[0]?job[0].id:'unknown'}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // Get job status
  if(req.method==='GET'&&url.startsWith('/jobs/status/')){
    const jobId=url.split('/jobs/status/')[1];
    (async()=>{
      const rows=await sbFetch('GET',`jobs?id=eq.${jobId}&select=id,status,type,agent,result,error,created_at,started_at,completed_at&limit=1`).catch(()=>null);
      if(!rows||!rows[0]){res.writeHead(404);return res.end(JSON.stringify({error:'Not found'}));}
      res.writeHead(200);res.end(JSON.stringify(rows[0]));
    })();return;
  }

  // List jobs for a user
  if(req.method==='GET'&&url.startsWith('/jobs/list')){
    const params=new URLSearchParams(req.url.split('?')[1]||'');
    const userId=params.get('userId')||'';
    (async()=>{
      const rows=await sbFetch('GET',`jobs?user_id=eq.${userId}&order=created_at.desc&limit=20&select=id,status,type,agent,prompt,created_at,completed_at,error`).catch(()=>[]);
      res.writeHead(200);res.end(JSON.stringify({jobs:rows||[]}));
    })();return;
  }

  // Cancel a job
  if(req.method==='POST'&&url==='/jobs/cancel'){
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      try{
        const{jobId,userId}=JSON.parse(b);
        await sbFetch('PATCH',`jobs?id=eq.${jobId}&user_id=eq.${userId}&status=eq.pending`,{status:'cancelled'});
        res.writeHead(200);res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
    });return;
  }

  // ── ADMIN ─────────────────────────────────────────
  if(req.method==='GET'&&url.startsWith('/admin/users')){
    const params = new URLSearchParams(req.url.split('?')[1]||'');
    const adminKey = params.get('key')||'';
    // Verify admin by checking if key matches service key prefix
    if (!CONFIG.SUPABASE_SERVICE_KEY) {
      res.writeHead(403); return res.end(JSON.stringify({ error: 'No service key configured' }));
    }

    // Fetch users using service role key
    const serviceKey = CONFIG.SUPABASE_SERVICE_KEY;
    const u = new URL(CONFIG.SUPABASE_URL);
    const opts = {
      hostname: u.hostname,
      path: '/auth/v1/admin/users?page=1&per_page=50',
      method: 'GET',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      }
    };
    const authReq = https.request(opts, authRes => {
      let d = ''; authRes.on('data', c => d += c);
      authRes.on('end', async () => {
        try {
          const data = JSON.parse(d);
          const users = data.users || [];

          // Get credit data for all users
          const credits = await sbFetch('GET', 'user_credits?select=user_id,credits,plan,total_used,sites_built&limit=100').catch(() => []);
          const creditMap = {};
          if (Array.isArray(credits)) credits.forEach(c => { creditMap[c.user_id] = c; });

          const enriched = users.map(u => ({
            id: u.id,
            email: u.email,
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at,
            plan: (creditMap[u.id] && creditMap[u.id].plan) || 'free',
            credits: (creditMap[u.id] && creditMap[u.id].credits) || 0,
            total_used: (creditMap[u.id] && creditMap[u.id].total_used) || 0,
            sites_built: (creditMap[u.id] && creditMap[u.id].sites_built) || 0,
          }));

          const paying = enriched.filter(u => u.plan && u.plan !== 'free').length;
          const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
          const active = enriched.filter(u => u.last_sign_in_at && u.last_sign_in_at > weekAgo).length;

          // Get sites log
          const sites = await sbFetch('GET', 'site_builds?select=url,task,site_name,built_at,user_id&order=built_at.desc&limit=50').catch(() => []);

          res.writeHead(200);
          res.end(JSON.stringify({
            total: users.length,
            active_week: active,
            paying: paying,
            users: enriched,
            sites: Array.isArray(sites) ? sites : []
          }));
        } catch(e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    authReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    authReq.end();
    return;
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
                email: customerEmail || null,
                morning_brief: true, // auto-enable for paid plans
                updated_at: new Date().toISOString()
              });
              console.log('[STRIPE] ✓ Plan updated to', mapping.plan, 'for', userId);
              slackNotify('🚀', 'New Subscriber', mapping.plan.toUpperCase() + ' plan — ' + (customerEmail || 'unknown'));
              // Send upgrade confirmation email
              if (customerEmail) {
                await sendEmail(
                  customerEmail,
                  `🌙 You're now on LUNARI ${mapping.plan.charAt(0).toUpperCase() + mapping.plan.slice(1)}`,
                  `welcome to the ${mapping.plan} plan.\n\nyou now have ${mapping.credits} Fuel and ${mapping.site_limit} site${mapping.site_limit > 1 ? 's' : ''}.\n\nthe crew is ready. let's build something.\n\n— RAVEN`,
                  'raven'
                );
              }
            } else {
              // Fuel pack — add to existing balance
              const current = await sbFetch('GET', `user_credits?user_id=eq.${userId}&select=credits&limit=1`).catch(() => null);
              const currentCredits = (current && current[0]) ? (current[0].credits || 0) : 0;
              await sbFetch('PATCH', `user_credits?user_id=eq.${userId}`, {
                credits: currentCredits + mapping.credits,
                email: customerEmail || null,
                updated_at: new Date().toISOString()
              });
              console.log('[STRIPE] ✓ Added', mapping.credits, 'Fuel →', currentCredits + mapping.credits, 'total for', userId);
              slackNotify('⚡', 'Fuel Purchased', mapping.credits + ' Fuel added → ' + (currentCredits + mapping.credits) + ' total');
              // Send fuel confirmation email
              if (customerEmail) {
                await sendEmail(
                  customerEmail,
                  `⚡ ${mapping.credits} Fuel added to your LUNARI account`,
                  `your fuel pack landed.\n\nyou now have ${currentCredits + mapping.credits} Fuel total.\n\nfuel burns when you build. chat is always free.\n\ngo build something.\n\n— RAVEN`,
                  'raven'
                );
              }
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
// ── JOB QUEUE ─────────────────────────────────────
const RUNNING_JOBS = {}; // in-memory set of currently running job IDs

async function processJobs() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.ANTHROPIC_KEY) return;
  try {
    // Pick up to 3 pending jobs at a time
    const pending = await sbFetch('GET', 'jobs?status=eq.pending&order=created_at.asc&limit=3');
    if (!pending || !pending.length) return;

    for (const job of pending) {
      if (RUNNING_JOBS[job.id]) continue; // already running
      RUNNING_JOBS[job.id] = true;

      // Mark as running
      await sbFetch('PATCH', `jobs?id=eq.${job.id}`, {
        status: 'running',
        started_at: new Date().toISOString()
      });

      console.log('[JOB] Starting:', job.id, job.type, job.agent);

      // Run async — don't await so multiple jobs can run in parallel
      runJob(job).then(async (result) => {
        await sbFetch('PATCH', `jobs?id=eq.${job.id}`, {
          status: 'done',
          result: result.slice(0, 50000), // cap at 50k chars
          completed_at: new Date().toISOString()
        });
        console.log('[JOB] Done:', job.id);
        delete RUNNING_JOBS[job.id];
      }).catch(async (err) => {
        await sbFetch('PATCH', `jobs?id=eq.${job.id}`, {
          status: 'failed',
          error: err.message,
          completed_at: new Date().toISOString()
        });
        console.error('[JOB] Failed:', job.id, err.message);
        delete RUNNING_JOBS[job.id];
      });
    }
  } catch(e) {
    console.error('[JOB QUEUE] Error:', e.message);
  }
}

async function runJob(job) {
  const type = job.type;
  const agent = job.agent || 'raven';
  const prompt = job.prompt || '';

  // Multi-step research job — the kind that takes 5-40 minutes
  if (type === 'research') {
    const steps = [
      `Do a thorough research overview on this topic: "${prompt}". Cover the landscape, key players, recent developments, and what matters most. Be comprehensive.`,
      `Based on your research on "${prompt}", identify the top opportunities, risks, and strategic insights. Go deep.`,
      `Synthesize everything into a final structured report on "${prompt}" with: Executive Summary, Key Findings, Opportunities, Risks, Recommended Actions. Format clearly.`
    ];
    let fullResult = '';
    for (let i = 0; i < steps.length; i++) {
      console.log(`[JOB] ${job.id} step ${i+1}/${steps.length}`);
      const stepResult = await callClaude(agent, steps[i] + (fullResult ? `\n\nContext from previous steps:\n${fullResult.slice(-2000)}` : ''), CONFIG.ANTHROPIC_KEY);
      fullResult += `\n\n--- Step ${i+1} ---\n${stepResult}`;
    }
    return fullResult;
  }

  if (type === 'strategy') {
    const steps = [
      `Analyze this business/marketing challenge in depth: "${prompt}". Cover the current situation, key variables, and what success looks like.`,
      `Generate 5 distinct strategic approaches for: "${prompt}". For each: the core idea, execution steps, timeline, risks, and expected outcome.`,
      `Build a complete 90-day action plan for: "${prompt}". Week by week for the first month, then month by month. Be specific and actionable.`
    ];
    let fullResult = '';
    for (let i = 0; i < steps.length; i++) {
      console.log(`[JOB] ${job.id} step ${i+1}/${steps.length}`);
      const stepResult = await callClaude(agent, steps[i] + (fullResult ? `\n\nPrevious analysis:\n${fullResult.slice(-2000)}` : ''), CONFIG.ANTHROPIC_KEY);
      fullResult += `\n\n--- Phase ${i+1} ---\n${stepResult}`;
    }
    return fullResult;
  }

  if (type === 'content_plan') {
    const steps = [
      `Research the content landscape for: "${prompt}". What's working, what's overdone, what gaps exist, who the audience is.`,
      `Generate 30 content ideas for: "${prompt}". Vary the format (articles, videos, threads, newsletters). Include angles, hooks, and why each works.`,
      `Build a complete 30-day content calendar for: "${prompt}". Day by day, with title, format, key message, and call to action for each piece.`
    ];
    let fullResult = '';
    for (let i = 0; i < steps.length; i++) {
      console.log(`[JOB] ${job.id} step ${i+1}/${steps.length}`);
      const stepResult = await callClaude(agent, steps[i] + (fullResult ? `\n\nPrevious work:\n${fullResult.slice(-2000)}` : ''), CONFIG.ANTHROPIC_KEY);
      fullResult += `\n\n--- Part ${i+1} ---\n${stepResult}`;
    }
    return fullResult;
  }

  // Default: single deep call with extended thinking time
  return await callClaude(agent, `Do a thorough, comprehensive job on this task. Take your time and go deep:\n\n${prompt}`, CONFIG.ANTHROPIC_KEY);
}

server.listen(CONFIG.PORT,()=>{
  console.log('[LUNARI] v4 on port '+CONFIG.PORT);
  console.log('[LUNARI] Anthropic: '+(CONFIG.ANTHROPIC_KEY?'SET':'NOT SET'));
  console.log('[LUNARI] Netlify: '+(CONFIG.NETLIFY_TOKEN?'SET':'NOT SET'));
  console.log('[LUNARI] Supabase: '+(CONFIG.SUPABASE_URL?'SET':'NOT SET'));
  console.log('[LUNARI] Slack: '+(CONFIG.SLACK_WEBHOOK?'SET':'NOT SET'));
  slackNotify('🟢', 'LUNARI ' + LUNARI_VERSION + ' Online', 'Server deployed and running. All systems active.');

  // Check for version change and auto-tweet if new
  setTimeout(function() {
    checkAndAnnounceVersion().catch(function(e) { console.error('[VERSION]', e.message); });
  }, 5000);
});

setInterval(tick, 60*1000);
setInterval(processJobs, 30*1000); // check for new jobs every 30s

// ── TELEGRAM BOT ──────────────────────────────────
const TG_SESSIONS = {}; // in-memory chat sessions keyed by chatId
let tgOffset = 0;

const AGENT_SYSTEMS_TG = {
  raven: 'You are RAVEN, lead agent of LUNARI. You\'re talking to a user via Telegram. Be direct, sharp, and genuinely helpful. You can route tasks to other agents by saying "let me get ATLAS/NOVA/GEN/X on that." Keep responses concise for mobile — under 400 words unless they need more.',
  nova: 'You are NOVA, content agent of LUNARI. On Telegram. Write full drafts, never outlines. Warm, vivid, direct.',
  atlas: 'You are ATLAS, research agent of LUNARI. On Telegram. Surface what matters most, lead with insights.',
  gen: 'You are GEN, marketing agent of LUNARI. On Telegram. Bold, direct strategy. No hedging.',
  x: 'You are X, first response at LUNARI. On Telegram. Warm, quick, human. Greet naturally, answer fast, route complex tasks to the right crew member. 1-3 sentences.'
};

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.TELEGRAM_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(bodyStr); req.end();
  });
}

function tgSend(chatId, text) {
  // Split long messages for Telegram's 4096 char limit
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let split = remaining.lastIndexOf('\n', 4000);
    if (split < 0) split = 4000;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  chunks.push(remaining);

  return chunks.reduce((p, chunk) => p.then(() =>
    tgRequest('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown'
    })
  ), Promise.resolve());
}

function detectTgAgent(text) {
  const lower = text.toLowerCase();
  if (lower.includes('@nova') || lower.includes('write') || lower.includes('draft')) return 'nova';
  if (lower.includes('@atlas') || lower.includes('research') || lower.includes('find')) return 'atlas';
  if (lower.includes('@gen') || lower.includes('strategy') || lower.includes('market')) return 'gen';
  if (lower.includes('@x') || lower.includes('quick') || lower.includes('short')) return 'x';
  return 'raven';
}

// Get linked user for a Telegram chat ID
async function getTgLinkedUser(chatId) {
  const rows = await sbAdmin('GET', `telegram_links?telegram_chat_id=eq.${chatId}&select=user_id,telegram_username&limit=1`).catch(() => null);
  return (rows && rows[0]) ? rows[0] : null;
}

// Generate a 6-char link code
function genLinkCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Load user's chat history from Supabase
async function tgLoadHistory(userId) {
  const rows = await sbFetch('GET', `chat_history?user_id=eq.${userId}&select=messages&limit=1`).catch(() => null);
  if (rows && rows[0] && rows[0].messages) return rows[0].messages.slice(-20);
  return [];
}

// Save messages back to Supabase
async function tgSaveHistory(userId, messages) {
  await sbFetch('POST', 'chat_history', {
    user_id: userId,
    messages: messages.slice(-50),
    updated_at: new Date().toISOString()
  }).catch(() => {});
}

// Get user's Fuel balance
async function tgGetCredits(userId) {
  const rows = await sbFetch('GET', `user_credits?user_id=eq.${userId}&select=credits,plan&limit=1`).catch(() => null);
  return (rows && rows[0]) ? rows[0] : { credits: 0, plan: 'free' };
}

async function handleTgMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const tgUsername = msg.from && msg.from.username ? msg.from.username : (msg.from && msg.from.first_name ? msg.from.first_name : 'there');

  // Init session
  if (!TG_SESSIONS[chatId]) {
    TG_SESSIONS[chatId] = { messages: [], agent: 'raven', userId: null, linked: false };
  }
  const session = TG_SESSIONS[chatId];

  // Check if linked (lazy load once per session)
  if (!session.linked) {
    const linked = await getTgLinkedUser(chatId);
    if (linked) {
      session.userId = linked.user_id;
      session.linked = true;
      // Load their web chat history
      if (session.messages.length === 0) {
        session.messages = await tgLoadHistory(linked.user_id);
      }
    }
  }

  // ── COMMANDS ──────────────────────────────────────

  if (text === '/start') {
    const linked = session.linked;
    await tgSend(chatId,
      `🌙 *welcome to LUNARI${linked ? '' : ', ' + tgUsername}.*\n\n` +
      `you just got a crew of five AI agents:\n` +
      `🪶 *RAVEN* — lead agent\n` +
      `✨ *NOVA* — writing & content\n` +
      `🗺️ *ATLAS* — research & intel\n` +
      `🌀 *GEN* — marketing strategy\n` +
      `✕ *X* — quick answers\n\n` +
      (linked
        ? `✓ *linked to your lunari.pro account.* your memory and Fuel carry over.\n\n`
        : `type /link to connect your lunari.pro account and sync your memory + Fuel.\n\n`) +
      `chat is free. what are we working on?`
    );
    return;
  }

  if (text === '/help') {
    await tgSend(chatId,
      `*LUNARI commands:*\n\n` +
      `just talk — RAVEN routes your request\n` +
      `@nova, @atlas, @gen, @x — route directly\n\n` +
      `/link — connect your lunari.pro account\n` +
      `/unlink — disconnect account\n` +
      `/status — your account status\n` +
      `/memory — what the crew remembers\n` +
      `/clear — clear conversation memory\n` +
      `/web — open lunari.pro\n` +
      `/help — this list`
    );
    return;
  }

  if (text === '/link') {
    if (session.linked) {
      await tgSend(chatId, `✓ already linked to your lunari.pro account.\n\nuse /unlink to disconnect.`);
      return;
    }
    // Generate a link code and store it temporarily
    const code = genLinkCode();
    // Store with null user_id temporarily — web will complete the link
    // Try insert first, fall back to update if row exists
    const insertRes = await sbAdmin('POST', 'telegram_links', {
      telegram_chat_id: chatId,
      telegram_username: tgUsername,
      link_code: code
    });
    console.log('[TG LINK] Insert result:', JSON.stringify(insertRes));
    if (!insertRes || (Array.isArray(insertRes) && !insertRes.length) || insertRes.code) {
      // Row exists — update the code
      const patchRes = await sbAdmin('PATCH', `telegram_links?telegram_chat_id=eq.${chatId}`, {
        link_code: code,
        telegram_username: tgUsername,
        user_id: null
      });
      console.log('[TG LINK] Patch result:', JSON.stringify(patchRes));
    }
    await tgSend(chatId,
      `🔗 *link your lunari.pro account*\n\n` +
      `your link code: \`${code}\`\n\n` +
      `go to lunari.pro → Settings → Telegram → enter this code\n\n` +
      `code expires in 10 minutes.`
    );
    return;
  }

  if (text === '/unlink') {
    if (!session.linked) {
      await tgSend(chatId, `no account linked yet. use /link to connect.`);
      return;
    }
    await sbAdmin('DELETE', `telegram_links?telegram_chat_id=eq.${chatId}`).catch(() => {});
    session.linked = false;
    session.userId = null;
    session.messages = [];
    await tgSend(chatId, `✓ account unlinked. your Telegram session is now independent.\n\nuse /link anytime to reconnect.`);
    return;
  }

  if (text === '/status') {
    if (!session.linked) {
      await tgSend(chatId,
        `*not linked.*\n\nuse /link to connect your lunari.pro account and sync Fuel, memory, and history.`
      );
      return;
    }
    const creds = await tgGetCredits(session.userId);
    await tgSend(chatId,
      `*your LUNARI account:*\n\n` +
      `⚡ Fuel: ${creds.credits}\n` +
      `📋 Plan: ${(creds.plan || 'free').toUpperCase()}\n` +
      `🔗 Linked: yes\n\n` +
      `chat is always free. Fuel only burns on builds.`
    );
    return;
  }

  if (text === '/memory') {
    const memCount = session.messages.length;
    if (memCount === 0) {
      await tgSend(chatId, `🧠 no memory yet. start chatting and the crew will remember.`);
    } else {
      await tgSend(chatId, `🧠 *${memCount} messages* in active memory.\n\nthe crew has context from this session.${session.linked ? ' history syncs to your lunari.pro account.' : ''}`);
    }
    return;
  }

  if (text === '/clear') {
    session.messages = [];
    if (session.linked && session.userId) {
      await tgSaveHistory(session.userId, []);
    }
    await tgSend(chatId, '🌙 memory cleared. fresh start.');
    return;
  }

  if (text === '/web') {
    await tgSend(chatId, '🌐 [lunari.pro](https://lunari.pro) — your full crew is there too.');
    return;
  }

  // ── AGENT RESPONSE ────────────────────────────────

  await tgRequest('sendChatAction', { chat_id: chatId, action: 'typing' });

  const agentId = detectTgAgent(text);
  const system = AGENT_SYSTEMS_TG[agentId];

  session.messages.push({ role: 'user', content: text });
  const trimmed = session.messages.slice(-12);

  try {
    const bodyStr = JSON.stringify({
      model: agentId === 'raven' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: system,
      messages: trimmed
    });
    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const reply = await new Promise((resolve, reject) => {
      const req = https.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const p = JSON.parse(d);
            if (p.error) return reject(new Error(p.error.message));
            resolve(p.content.filter(b => b.type === 'text').map(b => b.text).join(''));
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr); req.end();
    });

    session.messages.push({ role: 'assistant', content: reply });
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);

    // Save history to Supabase if linked
    if (session.linked && session.userId) {
      tgSaveHistory(session.userId, session.messages).catch(() => {});
    }

    const prefix = agentId === 'raven' ? '🪶' : agentId === 'nova' ? '✨' : agentId === 'atlas' ? '🗺️' : agentId === 'gen' ? '🌀' : '✕';
    await tgSend(chatId, `${prefix} *${agentId.toUpperCase()}*\n\n${reply}`);

  } catch(e) {
    console.error('[TG] Error:', e.message);
    await tgSend(chatId, '🪶 hit an error. try again?');
  }
}

// Poll Telegram for updates every 3 seconds
async function tgPoll() {
  if (!CONFIG.TELEGRAM_TOKEN) return;
  try {
    const res = await tgRequest('getUpdates', { offset: tgOffset, timeout: 2, limit: 10 });
    if (!res.ok || !res.result || !res.result.length) return;

    for (const update of res.result) {
      tgOffset = update.update_id + 1;
      if (update.message && update.message.text) {
        handleTgMessage(update.message).catch(e => console.error('[TG] Handler error:', e.message));
      }
    }
  } catch(e) {
    // Silent fail — network blip
  }
}

// Telegram broadcast — send message to all users with telegram_chat_id
async function tgBroadcast(message, userIds) {
  if (!CONFIG.TELEGRAM_TOKEN) return;
  // TODO: when users link their Telegram chat ID to their account
  console.log('[TG BROADCAST] Would send to', userIds ? userIds.length : 'all', 'users');
}

// Telegram link completion endpoint — called from web app
// Handled in handleRequest above

// Start polling if token is set
if (CONFIG.TELEGRAM_TOKEN) {
  setInterval(tgPoll, 3000);
  console.log('[LUNARI] Telegram: ACTIVE');

  setTimeout(() => {
    tgRequest('setMyCommands', { commands: [
      { command: 'start', description: 'Meet your LUNARI crew' },
      { command: 'link', description: 'Connect your lunari.pro account' },
      { command: 'status', description: 'Your Fuel and account status' },
      { command: 'memory', description: 'What the crew remembers' },
      { command: 'clear', description: 'Clear conversation memory' },
      { command: 'help', description: 'All commands' },
      { command: 'web', description: 'Open lunari.pro' },
    ]}).then(() => console.log('[TG] Commands set'));
  }, 2000);
}
