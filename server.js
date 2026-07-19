import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 5000;

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
  const { repoPath } = req.body;
  if (!repoPath) {
    return res.status(400).json({ error: 'repoPath is required' });
  }

  const resolvedPath = path.resolve(repoPath);
  if (!existsSync(resolvedPath)) {
    return res.status(400).json({ error: 'Directory does not exist locally' });
  }

  // Attempt to parse standard files
  const readme = await tryReadFile(path.join(resolvedPath, 'README.md'));
  const strategy = await tryReadFile(path.join(resolvedPath, 'BUSINESS_STRATEGY.md'));
  const posts = await tryReadFile(path.join(resolvedPath, 'LAUNCH_POSTS.md'));
  const issues = await tryReadFile(path.join(resolvedPath, 'PROPOSED_ISSUES.md'));

  // Detect project name & description
  let projectName = path.basename(resolvedPath);
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
});

// Proxy agent prompts to local OpenClaw gateway
app.post('/api/chat', async (req, res) => {
  const { agentId, messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages is required' });
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
    const gatewayConfig = await getOpenClawConfig();
    const endpoint = `http://localhost:${gatewayConfig.port}/v1/chat/completions`;

    const headers = {
      'Content-Type': 'application/json'
    };
    if (gatewayConfig.token) {
      headers['Authorization'] = `Bearer ${gatewayConfig.token}`;
    }

    const payload = {
      model: 'openclaw',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errMsg = await response.text();
      return res.status(response.status).json({ error: `OpenClaw returned error: ${errMsg}` });
    }

    const responseData = await response.json();
    const reply = responseData.choices?.[0]?.message?.content || 'No response from agent.';
    res.json({ reply });
  } catch (err) {
    console.error('Agent chat error:', err);
    res.status(500).json({ error: 'Failed to communicate with local OpenClaw gateway.' });
  }
});

// Serve frontend static files
app.use(express.static(path.join(path.resolve(), 'public')));

app.listen(PORT, () => {
  console.log(`LaunchForge running at http://localhost:${PORT}`);
});
