require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./lib/database');
const auth = require('./lib/auth');
const instagram = require('./lib/instagram');
const jobQueue = require('./lib/jobQueue');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH ROUTES =====
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const user = await auth.createUser(email, password);
    const token = auth.generateToken(user.id);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await auth.verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = auth.generateToken(user.id);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ===== INSTAGRAM ROUTES =====
app.post('/api/instagram/connect', auth.requireAuth, (req, res) => {
  try {
    const { sessionId, csrfToken, igUserId, username } = req.body;
    if (!sessionId || !csrfToken) return res.status(400).json({ error: 'Session ID and CSRF token required' });

    db.saveInstagramSession(req.user.id, { sessionId, csrfToken, igUserId, username });
    res.json({ success: true, message: 'Instagram connected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to connect Instagram' });
  }
});

app.get('/api/instagram/status', auth.requireAuth, (req, res) => {
  try {
    const session = db.getInstagramSession(req.user.id);
    const job = db.getActiveJob(req.user.id);
    const stats = db.getJobStats(req.user.id);

    res.json({
      connected: !!session,
      username: session?.username || null,
      job: job ? {
        id: job.id,
        status: job.status,
        total: job.total_count,
        processed: job.processed_count,
        unfollowed: job.unfollowed_count,
        errors: job.error_count,
        startedAt: job.started_at,
        lastActivity: job.last_activity
      } : null,
      stats
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.post('/api/instagram/scan', auth.requireAuth, async (req, res) => {
  try {
    const session = db.getInstagramSession(req.user.id);
    if (!session) return res.status(400).json({ error: 'Instagram not connected' });

    // Start scan as a background job
    const jobId = jobQueue.startScan(req.user.id, session);
    res.json({ success: true, jobId, message: 'Scan started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start scan: ' + err.message });
  }
});

app.post('/api/instagram/unfollow/start', auth.requireAuth, async (req, res) => {
  try {
    const session = db.getInstagramSession(req.user.id);
    if (!session) return res.status(400).json({ error: 'Instagram not connected' });

    const { whitelist = [], accountTier = 'growing' } = req.body;
    const jobId = jobQueue.startUnfollow(req.user.id, session, whitelist, accountTier);
    res.json({ success: true, jobId, message: 'Unfollow job started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start: ' + err.message });
  }
});

app.post('/api/instagram/unfollow/stop', auth.requireAuth, (req, res) => {
  try {
    jobQueue.stopJob(req.user.id);
    res.json({ success: true, message: 'Job stopping...' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop job' });
  }
});

app.get('/api/instagram/non-followers', auth.requireAuth, (req, res) => {
  try {
    const nonFollowers = db.getNonFollowers(req.user.id);
    res.json({ nonFollowers, count: nonFollowers.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get non-followers' });
  }
});

app.get('/api/instagram/logs', auth.requireAuth, (req, res) => {
  try {
    const logs = db.getJobLogs(req.user.id, 50);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ===== PAGE ROUTES =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'landing.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

// Start server & job queue
app.listen(PORT, () => {
  console.log(`UnfollowIQ running on http://localhost:${PORT}`);
  jobQueue.init();
});
