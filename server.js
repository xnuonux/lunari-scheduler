// LUNARI Scheduler + Execution Backend v2
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const CONFIG = {
  ANTHROPIC_KEY:    process.env.ANTHROPIC_API_KEY  || '',
  NETLIFY_TOKEN:    process.env.NETLIFY_API_TOKEN   || '',
  EMAILJS_SERVICE:  process.env.EMAILJS_SERVICE_ID  || 'service_3d0r898',
  EMAILJS_TEMPLATE: process.env.EMAILJS_TEMPLATE_ID || 'template_j4ecn66',
  EMAILJS_KEY:      process.env.EMAILJS_PUBLIC_KEY  || 'SnGkSaX1ThQBSysOU',
  PORT:             process.env.PORT                 || 3000,
};

const BUILD_RESULTS = {};

// CRON HELPERS
function parseCron(expr) {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return null;
  return { minute:p[0], hour:p[1], dom:p[2], month:p[3], dow:p[4] };
}
function cronMatches(expr, date) {
  const c = parseCron(expr);
  if (!c) return false;
  const m = (field, val) => {
    if (field==='*') return true;
    if (field.includes('/')) { const[,s]=field.split('/'); return val%parseInt(s)===0; }
    if (field.includes(',')) return field.split(',').map(Number).includes(val);
    if (field.includes('-')) { const[a,b]=field.split('-').map(Number); return val>=a&&val<=b; }
    return parseInt(field)===val;
  };
  return m(c.minute,date.getMinutes())&&m(c.hour,date.getHours())&&m(c.dom,date.getDate())&&m(c.month,date.getMonth()+1)&&m(c.dow,date.getDay());
}
function getNextRun(expr) {
  const next = new Date(Date.now()+60000);
  for (let i=0;i<60*24*7;i++) {
    next.setMinutes(next.getMinutes()+1);
    if (cronMatches(expr,next)) return next.toISOString();
  }
  return null;
}

// SCHEDULES
let SCHEDULES = [
  { id:'s1', name:'Morning Intelligence Briefing', agent:'scout', prompt:'Research the top 5 most important AI and technology news stories from the last 24 hours. For each story: headline, 2-sentence summary, why it matters for solo founders.', schedule:'0 8 * * *', email:'', enabled:true, lastRun:null, nextRun:getNextRun('0 8 * * *') },
  { id:'s2', name:'Weekly Marketing Strategy', agent:'spark', prompt:'Generate a complete 7-day marketing action plan for a solo founder. 3 content ideas, 1 email subject line, 1 growth tactic, 1 competitor to research.', schedule:'0 9 * * 1', email:'', enabled:false, lastRun:null, nextRun:getNextRun('0 9 * * 1') },
  { id:'s3', name:'Daily Content Piece', agent:'prose', prompt:'Write one high-quality LinkedIn post for a solo founder in the AI/technology space. 150-200 words, strong hook, ends with a question.', schedule:'0 10 * * *', email:'', enabled:false, lastRun:null, nextRun:getNextRun('0 10 * * *') },
];

// BUILD SYSTEM
function detectBuildType(task) {
  const l=task.toLowerCase();
  if (l.includes('landing page')||l.includes('landing')) return 'landing';
  if (l.includes('portfolio')) return 'portfolio';
  if (l.includes('blog')) return 'blog';
  if (l.includes('saas')||l.includes('platform')) return 'saas';
  if (l.includes('store')||l.includes('shop')) return 'ecommerce';
  if (l.includes('music')||l.includes('artist')||l.includes('band')) return 'music';
  return 'landing';
}
function generateSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,28).replace(/^-|-$/g,'')+'-'+Math.random().toString(36).slice(2,7);
}

function buildWithClaude(task, buildType, siteName) {
  return new Promise((resolve,reject) => {
    const system=`You are an elite web developer. Your ONLY job is to output a single complete HTML file. CRITICAL: Your entire response must be ONLY the HTML file. Start your response with <!DOCTYPE html> on the very first character. No preamble, no explanation, no markdown, no code fences. The HTML must render visible content immediately — include actual text, colors, images described with CSS, everything needed. Use inline CSS in a <style> tag. Use a body background color, real fonts, visible hero text, visible buttons. The page must look professional and fully rendered on first load.`;
    const user=`Build a complete ${buildType} website.\nTask: ${task}\nBrand: ${siteName||'extract from task'}\nInclude: hero with headline+CTA, features section, about/social proof, footer. Mobile responsive. Professional animations. Start with <!DOCTYPE html> immediately.`;
    const rb=JSON.stringify({model:'claude-opus-4-6',max_tokens:8000,system,messages:[{role:'user',content:user}]});
    const opts={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':CONFIG.ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}};
    const req=https.request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));const t=p.content.filter(b=>b.type==='text').map(b=>b.text).join('');resolve(t.replace(/^```html\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim());}catch(e){reject(e);}});});
    req.on('error',reject);req.write(rb);req.end();
  });
}

function deployToNetlify(html, slug) {
  return new Promise((resolve,reject) => {
    // Use Netlify's zip-based deploy for reliability
    const zlib = require('zlib');
    
    // Create a minimal zip file containing index.html
    // Using Netlify's simpler form-based deploy endpoint
    const siteName = 'lunari-' + slug;
    
    // Step 1: Create site
    const cb = JSON.stringify({ name: siteName });
    const co = {
      hostname:'api.netlify.com', path:'/api/v1/sites', method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,'Content-Length':Buffer.byteLength(cb)}
    };
    
    const cr = https.request(co, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const site = JSON.parse(d);
          if (!site.id) return reject(new Error('Site creation failed: ' + d.slice(0,300)));
          console.log('[BUILD] Site created: ' + site.id + ' url: ' + (site.ssl_url||site.url));
          
          // Step 2: Deploy using files API with correct content
          const htmlBuf = Buffer.from(html, 'utf8');
          const sha1 = crypto.createHash('sha1').update(htmlBuf).digest('hex');
          
          console.log('[BUILD] HTML size: ' + htmlBuf.length + ' bytes, sha1: ' + sha1);
          
          const deployPayload = JSON.stringify({
            files: { '/index.html': sha1 },
            draft: false,
            branch: 'main'
          });
          
          const dopt = {
            hostname:'api.netlify.com',
            path:`/api/v1/sites/${site.id}/deploys`,
            method:'POST',
            headers:{
              'Content-Type':'application/json',
              'Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,
              'Content-Length':Buffer.byteLength(deployPayload)
            }
          };
          
          const dr = https.request(dopt, dres => {
            let dd = '';
            dres.on('data', c => dd += c);
            dres.on('end', () => {
              try {
                const deploy = JSON.parse(dd);
                if (!deploy.id) return reject(new Error('Deploy creation failed: ' + dd.slice(0,300)));
                console.log('[BUILD] Deploy created: ' + deploy.id + ' required: ' + JSON.stringify(deploy.required));
                
                // Step 3: Upload the file
                const uo = {
                  hostname:'api.netlify.com',
                  path:`/api/v1/deploys/${deploy.id}/files/index.html`,
                  method:'PUT',
                  headers:{
                    'Content-Type':'text/html; charset=utf-8',
                    'Authorization':'Bearer '+CONFIG.NETLIFY_TOKEN,
                    'Content-Length':htmlBuf.length
                  }
                };
                
                const ur = https.request(uo, ures => {
                  let ud = '';
                  ures.on('data', c => ud += c);
                  ures.on('end', () => {
                    console.log('[BUILD] Upload status: ' + ures.statusCode + ' response: ' + ud.slice(0,100));
                    const finalUrl = site.ssl_url || site.url || ('https://' + siteName + '.netlify.app');
                    console.log('[BUILD] Final URL: ' + finalUrl);
                    resolve({ url: finalUrl, siteId: site.id });
                  });
                });
                
                ur.on('error', e => {
                  console.error('[BUILD] Upload error:', e.message);
                  reject(e);
                });
                ur.write(htmlBuf);
                ur.end();
                
              } catch(e) { reject(e); }
            });
          });
          dr.on('error', reject);
          dr.write(deployPayload);
          dr.end();
          
        } catch(e) { reject(e); }
      });
    });
    cr.on('error', reject);
    cr.write(cb);
    cr.end();
  });
}

async function executeBuild(task,userId,siteName,jobId) {
  BUILD_RESULTS[jobId]={status:'building',message:'Claude is building your site...'};
  try {
    const buildType=detectBuildType(task);
    BUILD_RESULTS[jobId].message='Generating your site...';
    const html=await buildWithClaude(task,buildType,siteName);
    if(!html||html.length<500)throw new Error('Insufficient output');
    BUILD_RESULTS[jobId].message='Deploying...';
    const slug=generateSlug(siteName||task);
    const result=await deployToNetlify(html,slug);
    BUILD_RESULTS[jobId]={status:'done',url:result.url,siteId:result.siteId,message:'Live at '+result.url,userId,builtAt:new Date().toISOString()};
    return BUILD_RESULTS[jobId];
  }catch(err){BUILD_RESULTS[jobId]={status:'error',error:err.message};throw err;}
}

// CLAUDE API
const AGENT_SYSTEMS={nexus:'You are NEXUS, lead agent of LUNARI. Sharp, direct, strategic co-founder energy.',prose:'You are PROSE, content agent of LUNARI. World-class writer. Full drafts only.',scout:'You are SCOUT, research agent of LUNARI. Surface non-obvious insights.',spark:'You are SPARK, marketing agent of LUNARI. Bold strategist. No hedging.'};
function callClaude(agent,prompt,apiKey){return new Promise((resolve,reject)=>{const b=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,system:AGENT_SYSTEMS[agent]||AGENT_SYSTEMS.nexus,messages:[{role:'user',content:prompt}]});const o={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(b)}};const r=https.request(o,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));resolve(p.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}catch(e){reject(e);}});});r.on('error',reject);r.write(b);r.end();});}

// EMAIL
function sendEmail(toEmail,subject,body,agentName){return new Promise((resolve)=>{const p=JSON.stringify({service_id:CONFIG.EMAILJS_SERVICE,template_id:CONFIG.EMAILJS_TEMPLATE,user_id:CONFIG.EMAILJS_KEY,template_params:{to_email:toEmail,subject,body:body.replace(/\*\*/g,'').replace(/\*/g,'').replace(/#+\s/g,''),agent:agentName.toUpperCase()}});const o={hostname:'api.emailjs.com',path:'/api/v1.0/email/send',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(p),'origin':'https://lunari.pro'}};const r=https.request(o,res=>{res.on('data',()=>{});res.on('end',()=>resolve(res.statusCode===200));});r.on('error',()=>resolve(false));r.write(p);r.end();});}

// SCHEDULE RUNNER
async function runSchedule(s){if(!s.enabled||!s.email||!CONFIG.ANTHROPIC_KEY)return;try{const r=await callClaude(s.agent,s.prompt,CONFIG.ANTHROPIC_KEY);await sendEmail(s.email,'LUNARI · '+s.name+' · '+new Date().toLocaleDateString(),r,s.agent);s.lastRun=new Date().toISOString();s.nextRun=getNextRun(s.schedule);}catch(e){console.error('[SCHEDULE] Failed:',e.message);}}
function tick(){const now=new Date();SCHEDULES.forEach(s=>{if(cronMatches(s.schedule,now))runSchedule(s);});}

// HTTP HANDLER
function handleRequest(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const url=req.url.split('?')[0];

  if(url==='/'||url==='/health'){res.writeHead(200);return res.end(JSON.stringify({status:'online',service:'LUNARI v2',uptime:Math.floor(process.uptime())+'s',netlify:CONFIG.NETLIFY_TOKEN?'SET':'NOT SET'}));}

  if(req.method==='POST'&&url==='/execute'){let b='';req.on('data',c=>b+=c);req.on('end',async()=>{try{const{task,userId,siteName}=JSON.parse(b);if(!task){res.writeHead(400);return res.end(JSON.stringify({error:'Missing task'}));}if(!CONFIG.ANTHROPIC_KEY){res.writeHead(500);return res.end(JSON.stringify({error:'No API key'}));}if(!CONFIG.NETLIFY_TOKEN){res.writeHead(500);return res.end(JSON.stringify({error:'No Netlify token'}));}const jobId=Date.now().toString();res.writeHead(200);res.end(JSON.stringify({ok:true,jobId,message:'Build started'}));executeBuild(task,userId,siteName,jobId).catch(e=>console.error('[BUILD]',e.message));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON'}));}});return;}

  if(req.method==='GET'&&url.startsWith('/execute/status/')){const jobId=url.split('/').pop();res.writeHead(200);return res.end(JSON.stringify(BUILD_RESULTS[jobId]||{status:'building',message:'Still working...'}));}

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
  console.log('[LUNARI] v2 on port '+CONFIG.PORT);
  console.log('[LUNARI] Anthropic: '+(CONFIG.ANTHROPIC_KEY?'SET':'NOT SET'));
  console.log('[LUNARI] Netlify: '+(CONFIG.NETLIFY_TOKEN?'SET':'NOT SET'));
});
setInterval(tick,60*1000);
