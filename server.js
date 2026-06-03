const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const { promisify } = require('util');
const resolveTxt = promisify(dns.resolveTxt);
require('dotenv').config();

const app = express();

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://quantum_db_ml2s_user:MPw4AwfSykHaGBGYz5TuwW1QXeHB5mKD@dpg-d8fvelk2m8qs73eeu2ug-a/quantum_db_ml2s',
  ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

// Create tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        domain TEXT UNIQUE NOT NULL,
        verification_token TEXT,
        verified BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS redirect_rules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
        subdomain TEXT,
        full_domain TEXT,
        target_url TEXT,
        bot_redirect TEXT,
        redirect_type TEXT DEFAULT 'cloaked',
        clicks INTEGER DEFAULT 0,
        unique_clicks INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS generated_links (
        id SERIAL PRIMARY KEY,
        rule_id INTEGER REFERENCES redirect_rules(id) ON DELETE CASCADE,
        generated_url TEXT,
        style TEXT,
        slug TEXT UNIQUE,
        parameters TEXT,
        clicks INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS click_logs (
        id SERIAL PRIMARY KEY,
        rule_id INTEGER REFERENCES redirect_rules(id) ON DELETE CASCADE,
        link_id INTEGER,
        ip TEXT,
        user_agent TEXT,
        referer TEXT,
        country TEXT,
        is_bot INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create admin user
    const hashedPassword = bcrypt.hashSync('Quantum2024!', 10);
    await pool.query(`
      INSERT INTO users (username, email, password) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (username) DO NOTHING
    `, ['admin', 'admin@quantum.com', hashedPassword]);
    
    console.log('✅ Database tables created/verified');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

initDB();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'quantum_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ============ DOMAIN VERIFICATION FUNCTION (FIXED) ============

async function verifyDomainDNS(domain, token) {
  try {
    console.log(`Checking TXT records for: ${domain}`);
    const records = await resolveTxt(domain);
    console.log(`Found ${records.length} TXT record sets`);
    
    // Flatten all records
    const allRecords = records.flat();
    console.log('All TXT records:', allRecords);
    
    // Check if any record contains the token
    const hasToken = allRecords.some(record => {
      const recordStr = Array.isArray(record) ? record.join('') : record;
      return recordStr.includes(token) || recordStr.includes(token.replace('quantum-verify=', ''));
    });
    
    if (hasToken) {
      console.log(`✅ Token found for ${domain}`);
    } else {
      console.log(`❌ Token NOT found for ${domain}`);
    }
    
    return hasToken;
  } catch (err) {
    console.log(`DNS lookup failed for ${domain}:`, err.code || err.message);
    return false;
  }
}

function generateVerificationToken(domain) {
  return `quantum-verify=${crypto.randomBytes(16).toString('hex')}`;
}

// ============ URL GENERATION FUNCTIONS ============

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

// ============ BOT DETECTION ============

function isBot(userAgent) {
  if (!userAgent) return true;
  const botPatterns = [
    /bot/i, /crawl/i, /spider/i, /scrape/i, /scan/i,
    /facebookexternalhit/i, /whatsapp/i, /telegrambot/i,
    /googlebot/i, /bingbot/i, /baiduspider/i,
    /python/i, /curl/i, /wget/i, /go-http-client/i
  ];
  return botPatterns.some(pattern => pattern.test(userAgent));
}

// ============ CLOAKED PAGE ============

function getCloakedPage(targetUrl, ruleId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Verifying Secure Connection...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Arial, sans-serif;
    }
    .container { text-align: center; color: white; }
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
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <script>setTimeout(function(){ window.location.href = '${targetUrl}'; }, 1500);</script>
</head>
<body>
  <div class="container">
    <div class="loader"></div>
    <h2>Verifying Secure Connection</h2>
  </div>
</body>
</html>`;
}

// ============ ROUTES ============

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Handle login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    const user = result.rows[0];
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      res.redirect('/dashboard.html');
    } else {
      res.send('<script>alert("Invalid credentials"); window.location.href="/login";</script>');
    }
  } catch (err) {
    res.status(500).send('Login error');
  }
});

// Serve dashboard
app.get('/dashboard.html', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============ API ROUTES ============

app.get('/api/domains', async (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  try {
    const result = await pool.query('SELECT * FROM domains WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/domains', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { domain } = req.body;
  const token = generateVerificationToken(domain);
  try {
    await pool.query('INSERT INTO domains (user_id, domain, verification_token) VALUES ($1, $2, $3)', 
      [req.session.userId, domain, token]);
    res.json({ verification_token: token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify domain - FIXED VERSION
app.post('/api/domains/:id/verify', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const domainResult = await pool.query('SELECT * FROM domains WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    const domain = domainResult.rows[0];
    
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    
    console.log(`Verifying domain: ${domain.domain}`);
    console.log(`Looking for token: ${domain.verification_token}`);
    
    const isValid = await verifyDomainDNS(domain.domain, domain.verification_token);
    
    if (isValid) {
      await pool.query('UPDATE domains SET verified = TRUE, verified_at = CURRENT_TIMESTAMP WHERE id = $1', [domain.id]);
      res.json({ verified: true, message: 'Domain verified successfully!' });
    } else {
      res.json({ 
        verified: false, 
        message: 'Verification failed. Make sure you added this exact TXT record to your DNS:\n\n' + domain.verification_token + '\n\nWait 5-10 minutes for DNS propagation, then try again.' 
      });
    }
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/domains/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM domains WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  const { domain_id, subdomain, target_url, style, count } = req.body;
  
  try {
    const domainResult = await pool.query('SELECT * FROM domains WHERE id = $1 AND user_id = $2 AND verified = TRUE', [domain_id, req.session.userId]);
    const domain = domainResult.rows[0];
    if (!domain) return res.status(400).json({ error: 'Domain not verified' });
    
    const fullDomain = subdomain ? `${subdomain}.${domain.domain}` : domain.domain;
    const slug = crypto.randomBytes(8).toString('hex');
    
    const ruleResult = await pool.query(
      `INSERT INTO redirect_rules (user_id, domain_id, subdomain, full_domain, target_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.session.userId, domain_id, subdomain, fullDomain, target_url]
    );
    
    const ruleId = ruleResult.rows[0].id;
    const urls = [];
    
    for (let i = 0; i < count; i++) {
      const uniqueSlug = `${slug}_${i}`;
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
      await pool.query(
        `INSERT INTO generated_links (rule_id, generated_url, style, slug)
         VALUES ($1, $2, $3, $4)`,
        [ruleId, generatedUrl, style, uniqueSlug]
      );
    }
    
    res.json({ urls, rule_id: ruleId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rules', async (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  try {
    const result = await pool.query(`
      SELECT r.*, d.domain as parent_domain 
      FROM redirect_rules r
      JOIN domains d ON r.domain_id = d.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
    `, [req.session.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.delete('/api/rules/:id', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM redirect_rules WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({});
  try {
    const domains = await pool.query('SELECT COUNT(*) as count FROM domains WHERE user_id = $1 AND verified = TRUE', [req.session.userId]);
    const rules = await pool.query('SELECT COUNT(*) as count FROM redirect_rules WHERE user_id = $1', [req.session.userId]);
    const clicks = await pool.query('SELECT SUM(clicks) as total FROM redirect_rules WHERE user_id = $1', [req.session.userId]);
    res.json({
      domains: parseInt(domains.rows[0].count) || 0,
      rules: parseInt(rules.rows[0].count) || 0,
      clicks: parseInt(clicks.rows[0].total) || 0
    });
  } catch (err) {
    res.json({ domains: 0, rules: 0, clicks: 0 });
  }
});

app.get('/api/logs', async (req, res) => {
  if (!req.session.userId) return res.status(401).json([]);
  try {
    const result = await pool.query(`
      SELECT l.*, r.full_domain, r.target_url
      FROM click_logs l
      LEFT JOIN redirect_rules r ON l.rule_id = r.id
      ORDER BY l.created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ============ REDIRECT HANDLER ============

app.get('*', async (req, res) => {
  const targetUrl = req.query.dest || req.query.url;
  
  if (targetUrl) {
    const userAgent = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const isBotDetected = isBot(userAgent);
    const ruleId = req.query.rid;
    
    try {
      await pool.query(
        `INSERT INTO click_logs (rule_id, ip, user_agent, is_bot) VALUES ($1, $2, $3, $4)`,
        [ruleId, ip, userAgent.substring(0, 500), isBotDetected ? 1 : 0]
      );
      if (ruleId) {
        await pool.query('UPDATE redirect_rules SET clicks = clicks + 1 WHERE id = $1', [ruleId]);
      }
    } catch (err) {
      console.error('Log error:', err);
    }
    
    if (isBotDetected) {
      return res.status(403).send('Access Denied');
    }
    
    return res.send(getCloakedPage(targetUrl, ruleId || 'unknown'));
  }
  
  res.status(404).send('Not Found');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('⚡ QUANTUM REDIRECT PANEL');
  console.log('========================================');
  console.log(`📍 URL: https://quantum-redirect-pn05.onrender.com/login`);
  console.log(`👤 Username: admin`);
  console.log(`🔑 Password: Quantum2024!`);
  console.log('========================================\n');
});
