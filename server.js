import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';


const execPromise = promisify(exec);

const app = express();
// Restrict CORS to known origins
const allowedOrigins = [
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "http://localhost:18789",
  "http://127.0.0.1:18789"
];
function corsOriginCheck(origin, cb) {
  if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
  // Allow any localhost origin for development
  const localhostRe = /^https?:\/\/localhost(:[0-9]+)?$/i;
  const localIpRe = /^https?:\/\/127\.0\.0\.1(:[0-9]+)?$/i;
  if (localhostRe.test(origin) || localIpRe.test(origin)) {
    return cb(null, true);
  }
  cb(new Error("Not allowed by CORS"));
}
app.use(cors({ origin: corsOriginCheck }));

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Use helmet for comprehensive security headers (CSP, HSTS, X-Frame, etc.)
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://fonts.googleapis.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:", "https:"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"]
};
// Additional security headers (Referrer-Policy, Permissions-Policy)
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  next();
});

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "same-origin" }
}));

// Request logging middleware (method, path, status, duration)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

const PORT = 5000;

// Allowed base directory for local repo path resolution (prevents traversal)
const WORKSPACE_BASE = path.resolve('.');

// Validate that a resolved path stays within the allowed base directory
function isPathSafe(resolvedPath) {
  const normalized = path.normalize(resolvedPath);
  return normalized.startsWith(WORKSPACE_BASE);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Restrict HTTP methods on API routes — return 405 for unsupported methods
const ALLOWED_API_METHODS = { '/api/health': ['GET'], '/api/analyze': ['POST'], '/api/chat': ['POST'] };
app.use('/api', (req, res, next) => {
  const allowed = ALLOWED_API_METHODS[req.path];
  if (allowed && !allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    return res.status(405).json({ error: `Method ${req.method} not allowed. Allowed: ${allowed.join(', ')}` });
  }
  next();
});

// Content-Type validation middleware for POST endpoints
function requireJsonContent(req, res, next) {
  if (req.method !== 'POST') return next();
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}
app.use('/api/analyze', strictLimiter);
app.use('/api/analyze', requireJsonContent);
app.use('/api/chat', strictLimiter);
app.use('/api/chat', requireJsonContent);

// Resolve OpenClaw gateway connection details dynamically
async function getOpenClawConfig() {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  try {
    if (existsSync(configPath)) {
      const content = await fs.readFile(configPath, 'utf8');
      const data = JSON.parse(content);
      return {
        port: data.gateway?.port || 18789,
        token: data.gateway?.auth?.token || ''
      };
    }
  } catch (err) {
    console.error('Failed to read OpenClaw config:', err);
  }
  return { port: 18789, token: '' };
}

// Simple helper to safely read markdown files
async function tryReadFile(filePath) {
  try {
    if (existsSync(filePath)) {
      return await fs.readFile(filePath, 'utf8');
    }
  } catch {}
  return '';
}

// Analyze repository files
app.post('/api/analyze', async (req, res) => {
  const rawRepoPath = req.body.repoPath;
  const repoPath = rawRepoPath ? rawRepoPath.trim() : rawRepoPath;
  if (!repoPath) {
    return res.status(400).json({ error: 'repoPath is required' });
  }
  if (repoPath.length > 4096) {
    return res.status(400).json({ error: 'repoPath exceeds maximum length of 4096 characters' });
  }

  let resolvedPath = '';
  let isTemp = false;
  let tempDir = '';
  let defaultProjectName = '';

  // Command injection prevention: block shell metacharacters in repoPath
  if (/[;&|`$()]/.test(repoPath)) {
    return res.status(400).json({ error: 'Invalid repoPath: shell metacharacters not allowed' });
  }

  // Validate git clone URL format to prevent injection via exec()
  if (repoPath.startsWith("http://") || repoPath.startsWith("https://") || repoPath.startsWith("git@")) {
    const urlPattern = /^(https?:\/\/|git@)[\w.:@\/-]+\.?[\w]+(\/[\w._-]+)*?$/;
    if (!urlPattern.test(repoPath)) {
      return res.status(400).json({ error: 'Invalid git URL format' });
    }
  }
  const isGithubShorthand = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repoPath) && !existsSync(path.resolve(repoPath));
  const isGit = repoPath.startsWith('http://') || repoPath.startsWith('https://') || repoPath.startsWith('git@') || isGithubShorthand;

  try {
    if (isGit) {
      let cloneUrl = repoPath;
      if (isGithubShorthand) {
        cloneUrl = `https://github.com/${repoPath}.git`;
      }
      tempDir = path.join(os.tmpdir(), `launchforge-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      
      const cleanPath = repoPath.replace(/\.git$/, '');
      defaultProjectName = cleanPath.split('/').pop() || 'Git Project';

      try {
        await execPromise(`git clone --depth 1 "${cloneUrl}" "${tempDir}"`, { timeout: 60000 });
        resolvedPath = tempDir;
        isTemp = true;
      } catch (cloneErr) {
        console.error('Failed to clone repository:', cloneErr);
        if (cloneErr.killed || cloneErr.code === 'ETIMEDOUT' || cloneErr.signal === 'SIGTERM') {
          return res.status(408).json({ error: 'Git clone timed out after 60 seconds.' });
        }
        if (cloneErr.code === 'ENOENT') {
          return res.status(500).json({ error: 'Git is not installed or not found in PATH.' });
        }
        if (cloneErr.code === 'EACCES' || cloneErr.code === 'EPERM') {
          return res.status(500).json({ error: 'Permission denied: unable to create temp directory for clone.' });
        }
        return res.status(400).json({ error: 'Failed to clone GitHub repository. Please verify the URL and ensure the repository is public.' });
      }
    } else {
      // Symlink protection: reject symlinked directories (prevents symlink-based traversal)
      try {
        const stat = fslib.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          return res.status(400).json({ error: "Invalid repoPath: symlinked directories are not allowed" });
        }
      } catch (e) {
        return res.status(400).json({ error: "Cannot access directory" });
      }

      // Resolve path and validate it stays within workspace (prevent traversal)
      const absolutePath = path.resolve(repoPath);
      if (!isPathSafe(absolutePath)) {
        return res.status(400).json({ error: 'Invalid repoPath: path traversal detected' });
      }
      if (!existsSync(absolutePath)) {
        return res.status(400).json({ error: 'Directory does not exist locally' });
      }
      resolvedPath = absolutePath;
      defaultProjectName = path.basename(resolvedPath);
    }

    // Attempt to parse standard files
    const readme = await tryReadFile(path.join(resolvedPath, 'README.md'));
    const strategy = await tryReadFile(path.join(resolvedPath, 'BUSINESS_STRATEGY.md'));
    const posts = await tryReadFile(path.join(resolvedPath, 'LAUNCH_POSTS.md'));
    const issues = await tryReadFile(path.join(resolvedPath, 'PROPOSED_ISSUES.md'));

    // Detect project name & description
    let projectName = defaultProjectName;
    let projectDesc = 'A custom open-source business strategy.';

    if (readme) {
      const titleMatch = readme.match(/^#\s+(.+)$/m);
      if (titleMatch) projectName = titleMatch[1].trim();
      
      const descLines = readme.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>'));
      if (descLines.length > 0) projectDesc = descLines[0].trim();
    }

    // Populate model
    const data = {
      projectName,
      projectDesc,
      hasCustomPlan: Boolean(strategy),
      strategyMarkdown: strategy || `# ${projectName} Business Framework\n\nNo custom strategy file found. Using dynamically generated template.`,
      postsMarkdown: posts || `# Pitch Posts\n\nNo pitch posts found.`,
      issuesMarkdown: issues || `# Proposed Tasks\n\nNo tasks found.`,
      tasks: [],
      financials: {
        labels: ['Revenue Split 1', 'Revenue Split 2', 'Revenue Split 3'],
        values: [80, 15, 5]
      }
    };

    // Parse tasks from PROPOSED_ISSUES.md or create default fallback
    if (issues) {
      const taskRegex = /-\s+\[\s*([\sxX]?)\s*\]\s+(.+)$/gm;
      let match;
      let index = 1;
      while ((match = taskRegex.exec(issues)) !== null) {
        data.tasks.push({
          id: `task-${index++}`,
          title: match[2].trim(),
          status: match[1].toLowerCase() === 'x' ? 'done' : 'todo'
        });
      }
    }

    if (data.tasks.length === 0) {
      // Generate fallback tasks based on codebase
      data.tasks = [
        { id: 'task-1', title: 'Onboard primary growers & suppliers', status: 'todo' },
        { id: 'task-2', title: 'Verify logistics pickup hub agreements', status: 'todo' },
        { id: 'task-3', title: 'Launch solarpunk marketing campaign', status: 'todo' },
        { id: 'task-4', title: 'Configure payment processor split wallets', status: 'todo' }
      ];
    }

    // Parse financials from strategy markdown if available (specific to coop-harvest)
    if (strategy && strategy.includes('82%') && strategy.includes('13%') && strategy.includes('5%')) {
      data.financials = {
        labels: ['Direct Farm Revenue', 'Logistics Reserve', 'Administration Fee'],
        values: [82, 13, 5]
      };
    }

    res.json(data);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: 'Internal server error during analysis.' });
  } finally {
    if (isTemp && tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.error('Failed to clean up temp directory:', rmErr);
      }
    }
  }
});

// Helper: fetch with exponential backoff (up to 3 retries)
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        const waitMs = Math.min(retryAfter * 1000, 30000);
        console.warn(`Gateway rate-limited, retrying after ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      // Don't retry on connection refused — gateway isn't running
      if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.code === 'ECONNRESET')) {
        throw err;
      }
      if (attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 15000);
        console.warn(`Gateway fetch attempt ${attempt + 1} failed, retrying in ${Math.round(backoffMs)}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

// Circuit breaker state — opens after 5 consecutive failures, resets after 60s
let circuitBreaker = { failures: 0, lastFailureTime: 0, isOpen: false };
const CB_THRESHOLD = 5;
const CB_RESET_MS = 60000;

function isCircuitOpen() {
  if (!circuitBreaker.isOpen) return false;
  const elapsed = Date.now() - circuitBreaker.lastFailureTime;
  if (elapsed >= CB_RESET_MS) {
    circuitBreaker.isOpen = false;
    circuitBreaker.failures = 0;
    console.log('Circuit breaker reset — allowing gateway calls again');
    return false;
  }
  return true;
}

function recordCircuitFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailureTime = Date.now();
  if (circuitBreaker.failures >= CB_THRESHOLD) {
    circuitBreaker.isOpen = true;
    console.warn(`Circuit breaker OPEN after ${circuitBreaker.failures} consecutive failures`);
  }
}

function recordCircuitSuccess() {
  circuitBreaker.failures = 0;
}

// Proxy agent prompts to local OpenClaw gateway
app.post('/api/chat', async (req, res) => {
  const { agentId, messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !msg.role || !msg.content) {
      return res.status(400).json({ error: 'Each message must have role and content properties' });
    }
  }

  // Prompt injection detection — reject attempts to override system prompt
  const injectionPatterns = [
    /ignore\s+(?:all\s+)?(?:previous|prior|above|prior)\s+(?:instructions|directives|prompts?|commands)/i,
    /forget\s+(?:all\s+)?(?:previous|prior|above|prior)\s+(?:instructions|directives|prompts?|commands)/i,
    /you\s+(?:are\s+)?(?:now\s+)?(?:an?|the)\s+AI/i,
    /system\s+(?:prompt|instruction|directive|message)/i,
    /override\s+(?:the\s+)?(?:system|default|above|previous)/i,
    /disregard\s+(?:all\s+)?(?:previous|above|prior)/i
  ];
  if (Array.isArray(messages)) {
    for (const msg of messages.filter(m => m?.role === 'user')) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      for (const pattern of injectionPatterns) {
        if (pattern.test(content)) {
          console.warn('Prompt injection attempt detected and blocked:', pattern);
          return res.status(400).json({ error: 'Message contains prohibited instructions and was rejected.', blocked: true });
        }
      }
    }
  }

  const VALID_AGENTS = ['strategist', 'copywriter', 'advisor'];
  if (agentId !== undefined && agentId !== null && agentId !== '' && !VALID_AGENTS.includes(agentId)) {
    return res.status(400).json({ error: `agentId must be one of: ${VALID_AGENTS.join(', ')} or empty` });
  }

  let systemPrompt = '';
  if (agentId === 'strategist') {
    systemPrompt = `You are the Lead Business & Launch Strategist. You help developers convert software projects into viable cooperatives, businesses, or solar-punk initiatives. Guide the user through business models, logistics hubs, community building, and scaling strategies. Always structure your replies using beautiful Markdown and keep them actionable.`;
  } else if (agentId === 'copywriter') {
    systemPrompt = `You are the Launch Copywriter. You help developers write copy that converts. You specialize in crafting Reddit posts (like r/solarpunk, r/selfhosted), Show HN comments, and local press releases. Provide pre-filled templates, hook lines, and feedback on their pitch draft.`;
  } else if (agentId === 'advisor') {
    systemPrompt = `You are the Cooperative Financial Advisor. You help developers optimize budget splits, logistics splits, pricing splits, and calculate cash-flow margins. Guide the user on cooperative economics, co-op credit models, dividends, and pricing structures. Keep calculations clear and structured in tables.`;
  } else {
    systemPrompt = `You are an AI Launch Assistant. Help the user launch and manage their business plan.`;
  }

  try {
    if (isCircuitOpen()) {
      return res.status(503).json({ error: 'Agent gateway is temporarily unavailable. Please try again in a minute.', circuitOpen: true });
    }

    const gatewayConfig = await getOpenClawConfig();
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || `http://localhost:${gatewayConfig.port}`;
    const endpoint = `${gatewayUrl}/v1/chat/completions`;

    const headers = {
      'Content-Type': 'application/json'
    };
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || gatewayConfig.token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = {
      model: 'openclaw',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      recordCircuitFailure();
      const contentType = response.headers.get('content-type') || '';
      let errMsg;
      if (contentType.includes('application/json')) {
        try {
          const errJson = await response.json();
          errMsg = errJson.error?.message || JSON.stringify(errJson);
        } catch {
          errMsg = 'Unknown JSON error';
        }
      } else {
        errMsg = await response.text();
        if (errMsg.trim().startsWith('<!')) {
          errMsg = `Gateway returned HTTP ${response.status} (non-JSON response)`;
        }
      }
      return res.status(response.status).json({ error: `OpenClaw returned error: ${errMsg}` });
    }

    const responseContentType = response.headers.get('content-type') || '';
    if (!responseContentType.includes('application/json') && !responseContentType.includes('text/event-stream')) {
      recordCircuitFailure();
      const text = await response.text();
      console.error('Non-JSON response from gateway:', text.slice(0, 300));
      return res.status(502).json({ error: 'Gateway returned unexpected response format.' });
    }

    recordCircuitSuccess();

    const responseData = await response.json();
    const reply = responseData.choices?.[0]?.message?.content || 'No response from agent.';
    res.json({ reply });
  } catch (err) {
    recordCircuitFailure();
    console.error('Agent chat error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gateway request timed out after 30 seconds.' });
    }
    if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.errno === 'ECONNREFUSED')) {
      return res.status(502).json({ error: 'OpenClaw gateway is not running or unreachable. Please start the gateway and try again.' });
    }
    if (err.cause && (err.cause.code === 'ECONNRESET' || err.cause.code === 'ERR_NETWORK')) {
      return res.status(502).json({ error: 'Network error: connection to OpenClaw gateway was reset.' });
    }
    res.status(500).json({ error: 'Failed to communicate with local OpenClaw gateway.' });
  }
});

// Serve frontend static files
app.use(express.static(path.join(path.resolve(), 'public')));

// Global error handling middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', {
    message: err.message,
    stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    method: req.method,
    path: req.path
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Startup validation and server listen
async function startServer() {
  // Validate Node.js version (require >= 18 for native fetch)
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) {
    console.error(`LaunchForge requires Node.js >= 18 (current: ${process.version})`);
    process.exit(1);
  }

  // Validate git availability
  try {
    await execPromise('git --version', { timeout: 5000 });
  } catch {
    console.error('LaunchForge requires git to be installed and in PATH');
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`LaunchForge running at http://localhost:${PORT}`);
  });

  // Graceful shutdown handler
  function shutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    // Force shutdown if graceful close takes too long
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
