// ═══════════════════════════════════════════════
// LUNARI Scheduler Backend
// Runs on Railway — executes scheduled agent tasks
// ═══════════════════════════════════════════════

const https = require('https');
const http = require('http');

// ── Config (set these as Railway environment variables) ──
const CONFIG = {
  ANTHROPIC_KEY:    process.env.ANTHROPIC_API_KEY || '',
  EMAILJS_SERVICE:  process.env.EMAILJS_SERVICE_ID || 'service_3d0r898',
  EMAILJS_TEMPLATE: process.env.EMAILJS_TEMPLATE_ID || 'template_j4ecn66',
  EMAILJS_KEY:      process.env.EMAILJS_PUBLIC_KEY || 'SnGkSaX1ThQBSysOU',
  PORT:             process.env.PORT || 3000,
};

// ── Default schedules (users will customize these via UI) ──
// In production these come from a database per user.
// For now they're stored in memory and reset on redeploy.
let SCHEDULES = [
  {
    id: 's1',
    name: 'Morning Intelligence Briefing',
    agent: 'scout',
    prompt: 'Research the top 5 most important AI and technology news stories from the last 24 hours. For each story give me: the headline, a 2-sentence summary, and why it matters for solo founders and small businesses. Format as a clean briefing report.',
    schedule: '0 8 * * *', // 8am daily
    email: '',             // filled in per user
    enabled: true,
    lastRun: null,
    nextRun: getNextRun('0 8 * * *'),
  },
  {
    id: 's2',
    name: 'Weekly Marketing Strategy',
    agent: 'spark',
    prompt: 'Generate a complete 7-day marketing action plan for a solo founder. Include: 3 content ideas with hooks, 1 email subject line worth testing, 1 growth tactic to try this week, and 1 competitor to research. Be specific and actionable.',
    schedule: '0 9 * * 1', // 9am every Monday
    email: '',
    enabled: false,
    lastRun: null,
    nextRun: getNextRun('0 9 * * 1'),
  },
  {
    id: 's3',
    name: 'Daily Content Piece',
    agent: 'prose',
    prompt: 'Write one high-quality LinkedIn post for a solo founder in the AI/technology space. The post should: share a genuine insight, be 150-200 words, have a strong opening hook, end with a question to drive comments. Make it feel human and authentic, not corporate.',
    schedule: '0 10 * * *', // 10am daily
    email: '',
    enabled: false,
    lastRun: null,
    nextRun: getNextRun('0 10 * * *'),
  },
];

// ── CRON parser (simple — no external deps needed) ──
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute:  parts[0],
    hour:    parts[1],
    dom:     parts[2],
    month:   parts[3],
    dow:     parts[4],
  };
}

function cronMatches(expr, date) {
  const c = parseCron(expr);
  if (!c) return false;
  const match = (field, val, max) => {
    if (field === '*') return true;
    if (field.includes('/')) {
      const [, step] = field.split('/');
      return val % parseInt(step) === 0;
    }
    if (field.includes(',')) return field.split(',').map(Number).includes(val);
    if (field.includes('-')) {
      const [a, b] = field.split('-').map(Number);
      return val >= a && val <= b;
    }
    return parseInt(field) === val;
  };
  return (
    match(c.minute, date.getMinutes()) &&
    match(c.hour,   date.getHours()) &&
    match(c.dom,    date.getDate()) &&
    match(c.month,  date.getMonth() + 1) &&
    match(c.dow,    date.getDay())
  );
}

function getNextRun(expr) {
  const now = new Date();
  const next = new Date(now.getTime() + 60000);
  // Scan forward up to 7 days to find next match
  for (let i = 0; i < 60 * 24 * 7; i++) {
    next.setMinutes(next.getMinutes() + 1);
    if (cronMatches(expr, next)) return next.toISOString();
  }
  return null;
}

// ── Claude API call ──────────────────────────────
const AGENT_SYSTEMS = {
  nexus: 'You are NEXUS, the Chief Executive Agent of LUNARI. You are a strategic commander. Break down goals, plan clearly, and deliver outstanding results. Be concise, sharp, and actionable.',
  prose: 'You are PROSE, the Content & Copy Agent of LUNARI. You are a world-class content creator. Write compelling, publication-ready content. No outlines — full drafts only.',
  scout: 'You are SCOUT, the Research & Intel Agent of LUNARI. You are a master researcher. Deliver structured, insight-rich reports with clear takeaways and actionable intelligence.',
  spark: 'You are SPARK, the Marketing Strategy Agent of LUNARI. You are an elite marketing strategist. Deliver complete, specific, immediately actionable strategic plans.',
};

function callClaude(agent, prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const system = AGENT_SYSTEMS[agent] || AGENT_SYSTEMS.nexus;
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content.filter(b => b.type === 'text').map(b => b.text).join('');
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── EmailJS send ─────────────────────────────────
function sendEmail(toEmail, subject, body, agentName) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      service_id:  CONFIG.EMAILJS_SERVICE,
      template_id: CONFIG.EMAILJS_TEMPLATE,
      user_id:     CONFIG.EMAILJS_KEY,
      template_params: {
        to_email: toEmail,
        subject,
        body: body.replace(/\*\*/g, '').replace(/\*/g, '').replace(/#+\s/g, ''),
        agent: agentName.toUpperCase(),
      },
    });

    const options = {
      hostname: 'api.emailjs.com',
      path: '/api/v1.0/email/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'origin': 'https://lunari.pro',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(res.statusCode === 200));
    });

    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ── Run a single scheduled task ──────────────────
async function runSchedule(schedule) {
  if (!schedule.enabled || !schedule.email || !CONFIG.ANTHROPIC_KEY) return;

  console.log(`[LUNARI] Running schedule: ${schedule.name}`);

  try {
    const result = await callClaude(schedule.agent, schedule.prompt, CONFIG.ANTHROPIC_KEY);
    const subject = `LUNARI · ${schedule.name} · ${new Date().toLocaleDateString()}`;
    const sent = await sendEmail(schedule.email, subject, result, schedule.agent);

    schedule.lastRun = new Date().toISOString();
    schedule.nextRun = getNextRun(schedule.schedule);

    console.log(`[LUNARI] Schedule "${schedule.name}" completed. Email sent: ${sent}`);
  } catch (err) {
    console.error(`[LUNARI] Schedule "${schedule.name}" failed:`, err.message);
  }
}

// ── Scheduler tick (runs every minute) ──────────
function tick() {
  const now = new Date();
  console.log(`[LUNARI] Tick: ${now.toISOString()}`);

  SCHEDULES.forEach(schedule => {
    if (cronMatches(schedule.schedule, now)) {
      runSchedule(schedule);
    }
  });
}

// ── HTTP API (for LUNARI frontend to talk to) ────
function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = req.url.split('?')[0];

  // Health check
  if (url === '/' || url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'online',
      service: 'LUNARI Scheduler',
      version: '1.0.0',
      schedules: SCHEDULES.length,
      uptime: Math.floor(process.uptime()) + 's',
    }));
  }

  // Get all schedules
  if (req.method === 'GET' && url === '/schedules') {
    res.writeHead(200);
    return res.end(JSON.stringify({ schedules: SCHEDULES }));
  }

  // Update a schedule
  if (req.method === 'POST' && url === '/schedules/update') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const idx = SCHEDULES.findIndex(s => s.id === data.id);
        if (idx >= 0) {
          SCHEDULES[idx] = { ...SCHEDULES[idx], ...data };
          if (data.schedule) SCHEDULES[idx].nextRun = getNextRun(data.schedule);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, schedule: SCHEDULES[idx] }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Schedule not found' }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Run a schedule immediately (for testing)
  if (req.method === 'POST' && url === '/schedules/run') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        const schedule = SCHEDULES.find(s => s.id === id);
        if (!schedule) {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'Schedule not found' }));
        }
        // Run async, respond immediately
        runSchedule(schedule);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: `Running "${schedule.name}" now` }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Add a new schedule
  if (req.method === 'POST' && url === '/schedules/add') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const newSchedule = {
          id: 's' + Date.now(),
          name: data.name || 'New Schedule',
          agent: data.agent || 'nexus',
          prompt: data.prompt || '',
          schedule: data.schedule || '0 8 * * *',
          email: data.email || '',
          enabled: false,
          lastRun: null,
          nextRun: getNextRun(data.schedule || '0 8 * * *'),
        };
        SCHEDULES.push(newSchedule);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, schedule: newSchedule }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Delete a schedule
  if (req.method === 'POST' && url === '/schedules/delete') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        SCHEDULES = SCHEDULES.filter(s => s.id !== id);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── Claude API Proxy (fixes CORS for browser) ──
  if (req.method === 'POST' && url === '/proxy/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const apiKey = payload.apiKey;
        const requestBody = payload.body;

        if (!apiKey || !requestBody) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'Missing apiKey or body' }));
        }

        const bodyStr = JSON.stringify(requestBody);
        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        };

        const proxyReq = https.request(options, (proxyRes) => {
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });

        proxyReq.on('error', (e) => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });

        proxyReq.write(bodyStr);
        proxyReq.end();
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── Start server ─────────────────────────────────
const server = http.createServer(handleRequest);

server.listen(CONFIG.PORT, () => {
  console.log(`[LUNARI] Scheduler running on port ${CONFIG.PORT}`);
  console.log(`[LUNARI] ${SCHEDULES.length} schedules loaded`);
  console.log(`[LUNARI] API key: ${CONFIG.ANTHROPIC_KEY ? 'SET' : 'NOT SET — set ANTHROPIC_API_KEY env var'}`);
});

// Tick every 60 seconds
setInterval(tick, 60 * 1000);

// Run once on startup to confirm it's working
console.log('[LUNARI] Scheduler started. First tick in 60 seconds.');
