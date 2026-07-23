// LaunchForge App Client Logic
document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentProject = {
    name: 'Coop-Harvest',
    desc: 'Loading strategy...',
    tasks: [],
    financials: { values: [82, 13, 5], labels: ['Farm', 'Logistics', 'Admin'] }
  };
  
  let chatHistories = {
    strategist: [
      { role: 'assistant', content: 'Hello! I am the Lead Business & Launch Strategist. How can I help you refine your co-op business model or pilot rollout plan today?' }
    ],
    copywriter: [
      { role: 'assistant', content: 'Hi there! I am your Copywriter. Ask me to draft or review your launch posts for Hacker News, Reddit, or your local press release!' }
    ],
    advisor: [
      { role: 'assistant', content: 'Greetings! I am the Cooperative Financial Advisor. Let me know if you want to analyze cooperative splits, logistics cost structures, or coop credits.' }
    ]
  };
  
  let activeAgent = 'strategist';

  // DOM Elements
  const repoPathInput = document.getElementById('repoPathInput');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const projectTitle = document.getElementById('projectTitle');
  const projectDesc = document.getElementById('projectDesc');
  const strategyContent = document.getElementById('strategyContent');
  
  const hnCopy = document.getElementById('hnCopy');
  const redditSolar = document.getElementById('reddit-solar');
  const pressRelease = document.getElementById('pressRelease');
  
  const crateCount = document.getElementById('crateCount');
  const crateCountVal = document.getElementById('crateCountVal');
  const cratePrice = document.getElementById('cratePrice');
  const cratePriceVal = document.getElementById('cratePriceVal');
  const farmSplit = document.getElementById('farmSplit');
  const farmSplitVal = document.getElementById('farmSplitVal');
  
  const totVolume = document.getElementById('totVolume');
  const farmPayout = document.getElementById('farmPayout');
  const logisticsPayout = document.getElementById('logisticsPayout');
  const adminPayout = document.getElementById('adminPayout');
  
  const todoTasks = document.getElementById('todoTasks');
  const progressTasks = document.getElementById('progressTasks');
  const doneTasks = document.getElementById('doneTasks');
  const newTaskInput = document.getElementById('newTaskInput');
  const addTaskBtn = document.getElementById('addTaskBtn');
  
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');

  // Simple Markdown Parser
  function parseMarkdown(md) {
    if (!md) return '';
    let html = md
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/^>\s+\[!IMPORTANT\]\s*\n>\s+\*\*([^*]+)\*\*\s*\n>\s+(.+)$/gm, '<blockquote class="alert"><strong>$1</strong><br>$2</blockquote>')
      .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/^-\s+(.+)$/gm, '<li>$1</li>')
      .replace(/<\/li>\n<li>/g, '</li><li>');
      
    // Wrap list items
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    return html;
  }

  // Accordion Logic
  document.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.parentElement;
      const wasActive = item.classList.contains('active');
      
      // Close other accordion items
      document.querySelectorAll('.accordion-item').forEach(i => i.classList.remove('active'));
      
      if (!wasActive) {
        item.classList.add('active');
      }
    });
  });

  // Tab Logic
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(`tab-${tabId}`).classList.add('active');
    });
  });

  // Analyze Repository
  async function loadRepository(repoPath) {
    projectDesc.textContent = 'Analyzing repository...';
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath })
      });
      
      if (!response.ok) {
        let errMsg = 'Analysis failed.';
        try {
          const errData = await response.json();
          errMsg = errData.error || errMsg;
        } catch {
          errMsg = await response.text() || errMsg;
        }
        throw new Error(errMsg);
      }
      
      const data = await response.json();
      currentProject = data;
      
      // Load saved tasks from localstorage if any
      const savedTasks = localStorage.getItem(`launchforge-tasks-${repoPath}`);
      if (savedTasks) {
        try {
          currentProject.tasks = JSON.parse(savedTasks);
        } catch (e) {
          console.warn('Failed to parse saved tasks, using defaults', e);
        }
      }
      
      // Update UI
      projectTitle.textContent = currentProject.projectName;
      projectDesc.textContent = currentProject.projectDesc;
      
      strategyContent.innerHTML = parseMarkdown(currentProject.strategyMarkdown);
      
      // Parse out pitch copies
      parsePitchCopy(currentProject.postsMarkdown);
      
      // Update Split visualizer
      farmSplit.value = currentProject.financials.values[0];
      
      renderFinancials();
      renderTasks();
      
      // Load chat history if any
      const savedHistory = localStorage.getItem(`launchforge-chat-${repoPath}`);
      if (savedHistory) {
        chatHistories = JSON.parse(savedHistory);
      } else {
        // Reset to initial defaults
        chatHistories = {
          strategist: [{ role: 'assistant', content: `Welcome to the ${currentProject.projectName} strategy launch! Ask me anything about marketing, cooperatives, or hubs.` }],
          copywriter: [{ role: 'assistant', content: 'Drafting posts for Hacker News or Reddit? Tell me what platforms you target.' }],
          advisor: [{ role: 'assistant', content: 'Let\'s run some calculations on your pricing splits. Ask me to split margins!' }]
        };
      }
      renderChat();

    } catch (err) {
      console.error(err);
      projectDesc.textContent = err.message || 'Analysis failed. Make sure the local path or GitHub URL is correct.';
    }
  }

  // Helper to extract codeblocks from pitch posts Markdown
  function parsePitchCopy(markdown) {
    if (!markdown) return;
    
    // Find HN pitch
    const hnRegex = /Show HN \([\s\S]+?```text\n([\s\S]+?)```/i;
    const hnMatch = hnRegex.exec(markdown);
    if (hnMatch) hnCopy.textContent = hnMatch[1].trim();

    // Find Reddit pitch
    const redditRegex = /r\/solarpunk[\s\S]+?```text\n([\s\S]+?)```/i;
    const redditMatch = redditRegex.exec(markdown);
    if (redditMatch) redditSolar.textContent = redditMatch[1].trim();

    // Find Press Release
    const prRegex = /Local Irish Media[\s\S]+?```text\n([\s\S]+?)```/i;
    const prMatch = prRegex.exec(markdown);
    if (prMatch) pressRelease.textContent = prMatch[1].trim();
  }

  // Copy Buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const text = document.getElementById(targetId).textContent;
      navigator.clipboard.writeText(text);
      
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = originalText, 1500);
    });
  });

  // Financial calculations
  function renderFinancials() {
    const count = parseInt(crateCount.value);
    const price = parseInt(cratePrice.value);
    const farmPct = parseInt(farmSplit.value);
    
    // Split logic matching the 82/13/5 ratio dynamically
    const remaining = 100 - farmPct;
    const logisticsPct = Math.round(remaining * 0.72);
    const adminPct = 100 - farmPct - logisticsPct;
    
    const volume = count * price;
    const farmVal = Math.round((volume * farmPct) / 100);
    const logisticsVal = Math.round((volume * logisticsPct) / 100);
    const adminVal = volume - farmVal - logisticsVal;
    
    crateCountVal.textContent = count;
    cratePriceVal.textContent = `€${price}`;
    farmSplitVal.textContent = `${farmPct}%`;
    
    totVolume.textContent = `€${volume.toLocaleString()}`;
    farmPayout.textContent = `€${farmVal.toLocaleString()}`;
    logisticsPayout.textContent = `€${logisticsVal.toLocaleString()}`;
    adminPayout.textContent = `€${adminVal.toLocaleString()}`;
    
    // Update visual bars
    const farmSeg = document.querySelector('.farm-seg');
    const logSeg = document.querySelector('.log-seg');
    const adminSeg = document.querySelector('.admin-seg');
    
    farmSeg.style.width = `${farmPct}%`;
    farmSeg.textContent = `Farm: ${farmPct}%`;
    logSeg.style.width = `${logisticsPct}%`;
    logSeg.textContent = `Logistics: ${logisticsPct}%`;
    adminSeg.style.width = `${adminPct}%`;
    adminSeg.textContent = `Admin: ${adminPct}%`;
  }

  crateCount.addEventListener('input', renderFinancials);
  cratePrice.addEventListener('input', renderFinancials);
  farmSplit.addEventListener('input', renderFinancials);

  // Kanban Tasks
  function renderTasks() {
    const todoList = document.getElementById('todo-tasks');
    const progressList = document.getElementById('progress-tasks');
    const doneList = document.getElementById('done-tasks');
    
    todoList.innerHTML = '';
    progressList.innerHTML = '';
    doneList.innerHTML = '';
    
    currentProject.tasks.forEach(task => {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.textContent = task.title;
      
      const controls = document.createElement('div');
      controls.className = 'task-controls';
      
      if (task.status !== 'todo') {
        const leftBtn = document.createElement('button');
        leftBtn.className = 'task-ctrl-btn';
        leftBtn.textContent = '◀';
        leftBtn.addEventListener('click', () => moveTask(task.id, getPrevStatus(task.status)));
        controls.appendChild(leftBtn);
      }
      
      if (task.status !== 'done') {
        const rightBtn = document.createElement('button');
        rightBtn.className = 'task-ctrl-btn';
        rightBtn.textContent = '➔';
        rightBtn.addEventListener('click', () => moveTask(task.id, getNextStatus(task.status)));
        controls.appendChild(rightBtn);
      }
      
      const delBtn = document.createElement('button');
      delBtn.className = 'task-ctrl-btn';
      delBtn.textContent = '🗑️';
      delBtn.addEventListener('click', () => deleteTask(task.id));
      controls.appendChild(delBtn);
      
      card.appendChild(controls);
      
      if (task.status === 'todo') todoList.appendChild(card);
      else if (task.status === 'progress') progressList.appendChild(card);
      else if (task.status === 'done') doneList.appendChild(card);
    });
  }

  function getPrevStatus(status) {
    if (status === 'progress') return 'todo';
    if (status === 'done') return 'progress';
    return 'todo';
  }

  function getNextStatus(status) {
    if (status === 'todo') return 'progress';
    if (status === 'progress') return 'done';
    return 'done';
  }

  function moveTask(id, nextStatus) {
    currentProject.tasks = currentProject.tasks.map(t => t.id === id ? { ...t, status: nextStatus } : t);
    saveTasks();
    renderTasks();
  }

  function deleteTask(id) {
    currentProject.tasks = currentProject.tasks.filter(t => t.id !== id);
    saveTasks();
    renderTasks();
  }

  function saveTasks() {
    localStorage.setItem(`launchforge-tasks-${repoPathInput.value}`, JSON.stringify(currentProject.tasks));
  }

  addTaskBtn.addEventListener('click', () => {
    const val = newTaskInput.value.trim();
    if (!val) return;
    
    const newTask = {
      id: `task-${Date.now()}`,
      title: val,
      status: 'todo'
    };
    
    currentProject.tasks.push(newTask);
    newTaskInput.value = '';
    saveTasks();
    renderTasks();
  });

  // Agent Chat
  document.querySelectorAll('.agent-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      activeAgent = btn.getAttribute('data-agent');
      renderChat();
    });
  });

  function renderChat() {
    chatMessages.innerHTML = '';
    const history = chatHistories[activeAgent];
    history.forEach(msg => {
      const bubble = document.createElement('div');
      bubble.className = `message ${msg.role}`;
      bubble.textContent = msg.content;
      chatMessages.appendChild(bubble);
    });
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function sendChatMessage() {
    const val = chatInput.value.trim();
    if (!val) return;
    
    // Add User bubble
    chatHistories[activeAgent].push({ role: 'user', content: val });
    chatInput.value = '';
    renderChat();
    
    // Add Assistant Typing bubble
    const typingBubble = document.createElement('div');
    typingBubble.className = 'message assistant typing';
    typingBubble.textContent = 'Thinking...';
    chatMessages.appendChild(typingBubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeAgent,
          messages: chatHistories[activeAgent].slice(-5) // Send last 5 turns to preserve context window limit
        })
      });
      
      if (!response.ok) {
        throw new Error(await response.text());
      }
      
      const data = await response.json();
      
      // Remove typing bubble
      chatMessages.removeChild(typingBubble);
      
      // Save assistant reply
      chatHistories[activeAgent].push({ role: 'assistant', content: data.reply });
      localStorage.setItem(`launchforge-chat-${repoPathInput.value}`, JSON.stringify(chatHistories));
      renderChat();
      
    } catch (err) {
      console.error(err);
      chatMessages.removeChild(typingBubble);
      const errorBubble = document.createElement('div');
      errorBubble.className = 'message system';
      errorBubble.textContent = 'Consultation failed. Check OpenClaw gateway connection.';
      chatMessages.appendChild(errorBubble);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  sendChatBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Setup repo reload listener
  analyzeBtn.addEventListener('click', () => {
    loadRepository(repoPathInput.value);
  });

  // Initial Load
  loadRepository(repoPathInput.value);
});
