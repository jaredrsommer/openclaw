/**
 * Dashboard HTML — self-contained single-page app with inline CSS/JS.
 * Connects to the SSE endpoint for real-time fleet state updates.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ApexClaw Trading Fleet</title>
<style>
  :root {
    --bg: #0a0e17; --bg2: #111827; --bg3: #1a2332;
    --border: #2a3a4e; --text: #e2e8f0; --dim: #64748b;
    --green: #22c55e; --red: #ef4444; --yellow: #eab308; --blue: #3b82f6;
    --purple: #a855f7; --cyan: #06b6d4; --orange: #f97316;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: var(--bg); color: var(--text); font-size: 13px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .header h1 span { color: var(--cyan); }
  .status-badge { padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .status-running { background: rgba(34,197,94,0.15); color: var(--green); border: 1px solid rgba(34,197,94,0.3); }
  .status-paused { background: rgba(234,179,8,0.15); color: var(--yellow); border: 1px solid rgba(234,179,8,0.3); }
  .status-emergency-stop { background: rgba(239,68,68,0.15); color: var(--red); border: 1px solid rgba(239,68,68,0.3); }
  .status-starting { background: rgba(59,130,246,0.15); color: var(--blue); border: 1px solid rgba(59,130,246,0.3); }
  .controls { display: flex; gap: 8px; align-items: center; }
  .controls button { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; font-size: 12px; font-family: inherit; }
  .controls button:hover { background: var(--border); }
  .btn-danger { border-color: var(--red) !important; color: var(--red) !important; }
  .btn-danger:hover { background: rgba(239,68,68,0.2) !important; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; padding: 16px 24px; }
  .grid-wide { grid-template-columns: 1fr 1fr; }
  .grid-full { grid-template-columns: 1fr; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .card-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 600; }
  .card-value { font-size: 28px; font-weight: 700; }
  .node-card { position: relative; overflow: hidden; }
  .node-card .role-tag { position: absolute; top: 0; right: 0; padding: 4px 12px; font-size: 10px; font-weight: 700; text-transform: uppercase; border-bottom-left-radius: 8px; }
  .role-sentinel { background: var(--cyan); color: var(--bg); }
  .role-strategist { background: var(--purple); color: var(--bg); }
  .role-coder { background: var(--orange); color: var(--bg); }
  .role-queen { background: var(--yellow); color: var(--bg); }
  .node-name { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  .node-host { font-size: 11px; color: var(--dim); margin-bottom: 12px; }
  .node-health { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .node-health.healthy { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .node-health.unhealthy { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .node-stat { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  .node-stat .label { color: var(--dim); }
  .agent-list { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .agent-chip { padding: 2px 8px; border-radius: 4px; font-size: 10px; background: var(--bg3); border: 1px solid var(--border); }
  .agent-chip.running { border-color: var(--green); color: var(--green); }
  .agent-chip.error { border-color: var(--red); color: var(--red); }
  .model-tag { padding: 2px 8px; border-radius: 4px; font-size: 10px; background: rgba(6,182,212,0.1); color: var(--cyan); border: 1px solid rgba(6,182,212,0.2); }
  .section-title { padding: 16px 24px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); padding: 8px 12px; border-bottom: 1px solid var(--border); font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
  tr:hover { background: rgba(255,255,255,0.02); }
  .tier-local { color: var(--green); }
  .tier-free-api { color: var(--cyan); }
  .tier-paid-api { color: var(--yellow); }
  .progress-bar { height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .progress-fill { height: 100%; background: var(--cyan); border-radius: 3px; transition: width 0.5s; }
  .event-log { max-height: 250px; overflow-y: auto; font-size: 11px; }
  .event-entry { padding: 4px 8px; border-bottom: 1px solid rgba(42,58,78,0.5); }
  .event-time { color: var(--dim); margin-right: 8px; }
  .event-type { font-weight: 600; margin-right: 8px; }
  .pipeline-stage { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .pipeline-dot { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
  .pipeline-dot.active { border-color: var(--cyan); background: rgba(6,182,212,0.2); color: var(--cyan); }
  .pipeline-dot.done { border-color: var(--green); background: rgba(34,197,94,0.2); color: var(--green); }
  .pipeline-line { flex: 1; height: 2px; background: var(--border); }
  .pipeline-line.done { background: var(--green); }
  .stats-row { display: flex; gap: 24px; padding: 16px 24px; }
  .stat-box { text-align: center; }
  .stat-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; }
  .stat-value { font-size: 20px; font-weight: 700; }
  .stat-green { color: var(--green); }
  .stat-red { color: var(--red); }
  .connected-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .connected-dot.live { background: var(--green); animation: pulse 2s infinite; }
  .connected-dot.dead { background: var(--red); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  /* Agent Comms Panel */
  .comms-container { display: grid; grid-template-columns: 220px 1fr 280px; gap: 12px; padding: 0 24px 16px; min-height: 340px; }
  .comms-agents { display: flex; flex-direction: column; gap: 4px; }
  .comms-agent { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--bg2); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .comms-agent:hover { border-color: var(--cyan); }
  .comms-agent.selected { border-color: var(--cyan); background: rgba(6,182,212,0.08); }
  .comms-avatar { width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; flex-shrink: 0; }
  .comms-agent-info { flex: 1; min-width: 0; }
  .comms-agent-name { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .comms-agent-name input { background: transparent; border: 1px solid var(--cyan); color: var(--text); font-family: inherit; font-size: 11px; font-weight: 600; padding: 0 4px; width: 100%; border-radius: 3px; outline: none; }
  .comms-agent-id { font-size: 9px; color: var(--dim); }
  .comms-agent-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; }
  .comms-agent-badge.active { background: rgba(34,197,94,0.15); color: var(--green); }
  .comms-agent-badge.idle { background: rgba(100,116,139,0.15); color: var(--dim); }

  .comms-feed { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; }
  .comms-feed-header { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .comms-feed-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 600; }
  .comms-feed-filter { display: flex; gap: 4px; }
  .comms-feed-filter button { padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--dim); cursor: pointer; font-size: 10px; font-family: inherit; }
  .comms-feed-filter button.active { border-color: var(--cyan); color: var(--cyan); background: rgba(6,182,212,0.1); }
  .comms-messages { flex: 1; overflow-y: auto; padding: 8px; }
  .comms-msg { padding: 6px 10px; margin-bottom: 4px; border-radius: 6px; background: var(--bg3); border-left: 3px solid var(--border); animation: fadeIn 0.2s; }
  .comms-msg.topic-signals { border-left-color: var(--green); }
  .comms-msg.topic-rbi { border-left-color: var(--purple); }
  .comms-msg.topic-risk { border-left-color: var(--red); }
  .comms-msg.topic-analysis { border-left-color: var(--orange); }
  .comms-msg.topic-system { border-left-color: var(--yellow); }
  .comms-msg.topic-direct { border-left-color: var(--cyan); }
  .comms-msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
  .comms-msg-from { font-size: 11px; font-weight: 700; }
  .comms-msg-arrow { color: var(--dim); font-size: 10px; margin: 0 4px; }
  .comms-msg-to { font-size: 11px; font-weight: 600; color: var(--dim); }
  .comms-msg-topic { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(100,116,139,0.2); color: var(--dim); }
  .comms-msg-time { font-size: 9px; color: var(--dim); }
  .comms-msg-summary { font-size: 11px; color: var(--text); opacity: 0.85; margin-top: 2px; }
  .comms-msg-chain { font-size: 9px; color: var(--dim); margin-top: 2px; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  .comms-stats { display: flex; flex-direction: column; gap: 8px; }
  .comms-stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .comms-stat-title { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 600; margin-bottom: 6px; }
  .comms-stat-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; }
  .comms-stat-val { font-weight: 600; }
  .topic-bar { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .topic-bar-label { font-size: 10px; color: var(--dim); width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topic-bar-fill { height: 4px; border-radius: 2px; background: var(--cyan); transition: width 0.3s; }
  .topic-bar-count { font-size: 10px; color: var(--dim); width: 30px; text-align: right; }
</style>
</head>
<body>

<div class="header">
  <div style="display:flex;align-items:center;gap:16px">
    <h1>Apex<span>Claw</span></h1>
    <span id="queen-state" class="status-badge status-starting">STARTING</span>
    <span style="font-size:11px;color:var(--dim)"><span id="conn-dot" class="connected-dot dead"></span><span id="conn-text">Connecting...</span></span>
  </div>
  <div class="controls">
    <button onclick="sendCmd('resume')">Resume</button>
    <button onclick="sendCmd('pause')">Pause</button>
    <button class="btn-danger" onclick="if(confirm('EMERGENCY STOP — halt all trading?')) sendCmd('emergency-stop')">Emergency Stop</button>
  </div>
</div>

<!-- Top stats -->
<div class="stats-row">
  <div class="stat-box"><div class="stat-label">Uptime</div><div class="stat-value" id="stat-uptime">--</div></div>
  <div class="stat-box"><div class="stat-label">Healthy Nodes</div><div class="stat-value" id="stat-nodes">-/-</div></div>
  <div class="stat-box"><div class="stat-label">Total Inferences</div><div class="stat-value" id="stat-inferences">0</div></div>
  <div class="stat-box"><div class="stat-label">Local (free)</div><div class="stat-value stat-green" id="stat-local">0</div></div>
  <div class="stat-box"><div class="stat-label">Free API</div><div class="stat-value" style="color:var(--cyan)" id="stat-freeapi">0</div></div>
  <div class="stat-box"><div class="stat-label">Paid API</div><div class="stat-value" style="color:var(--yellow)" id="stat-paidapi">$0.00</div></div>
  <div class="stat-box"><div class="stat-label">Risk Level</div><div class="stat-value" id="stat-risk">--</div></div>
</div>

<!-- Fleet nodes -->
<div class="section-title">Fleet Nodes (4x GTX 1070 Ti)</div>
<div class="grid" id="nodes-grid">
  <div class="card">Loading...</div>
</div>

<!-- Agent table + RBI pipeline -->
<div class="section-title">Agents &amp; RBI Pipeline</div>
<div class="grid grid-wide" style="padding-top:0">
  <div class="card">
    <div class="card-header"><span class="card-title">Active Agents</span></div>
    <table>
      <thead><tr><th>Agent</th><th>Node</th><th>Status</th><th>Runs</th><th>Last Run</th></tr></thead>
      <tbody id="agents-tbody"><tr><td colspan="5">Loading...</td></tr></tbody>
    </table>
  </div>
  <div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-header"><span class="card-title">RBI Pipeline</span></div>
      <div class="pipeline-stage">
        <div class="pipeline-dot" id="rbi-r">R</div>
        <div class="pipeline-line" id="rbi-l1"></div>
        <div class="pipeline-dot" id="rbi-b">B</div>
        <div class="pipeline-line" id="rbi-l2"></div>
        <div class="pipeline-dot" id="rbi-i">I</div>
      </div>
      <div style="font-size:12px;color:var(--dim)" id="rbi-status">Idle</div>
      <div class="progress-bar"><div class="progress-fill" id="rbi-progress" style="width:0%"></div></div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Event Log</span></div>
      <div class="event-log" id="event-log"></div>
    </div>
  </div>
</div>

<!-- Agent Communications -->
<div class="section-title">Agent Communications (Message Bus)</div>
<div class="comms-container">
  <!-- Left: Agent list with custom names -->
  <div class="comms-agents" id="comms-agents">
    <div style="font-size:10px;color:var(--dim);padding:4px">Loading agents...</div>
  </div>

  <!-- Center: Real-time message feed -->
  <div class="comms-feed">
    <div class="comms-feed-header">
      <span class="comms-feed-title" id="comms-feed-title">All Messages</span>
      <div class="comms-feed-filter">
        <button class="active" onclick="setCommsFilter('all')">All</button>
        <button onclick="setCommsFilter('signals')">Signals</button>
        <button onclick="setCommsFilter('rbi')">RBI</button>
        <button onclick="setCommsFilter('risk')">Risk</button>
        <button onclick="setCommsFilter('system')">System</button>
      </div>
    </div>
    <div class="comms-messages" id="comms-messages">
      <div style="padding:20px;text-align:center;color:var(--dim);font-size:11px">Waiting for agent communications...</div>
    </div>
  </div>

  <!-- Right: Bus stats -->
  <div class="comms-stats">
    <div class="comms-stat-card">
      <div class="comms-stat-title">Bus Activity</div>
      <div class="comms-stat-row"><span>Published</span><span class="comms-stat-val" id="bus-published">0</span></div>
      <div class="comms-stat-row"><span>Delivered</span><span class="comms-stat-val" id="bus-delivered">0</span></div>
      <div class="comms-stat-row"><span>Dropped</span><span class="comms-stat-val" style="color:var(--red)" id="bus-dropped">0</span></div>
      <div class="comms-stat-row"><span>Subscriptions</span><span class="comms-stat-val" id="bus-subs">0</span></div>
      <div class="comms-stat-row"><span>History</span><span class="comms-stat-val" id="bus-history">0</span></div>
      <div class="comms-stat-row"><span>Context Store</span><span class="comms-stat-val" id="bus-context">0</span></div>
    </div>
    <div class="comms-stat-card">
      <div class="comms-stat-title">Signal Dedup</div>
      <div class="comms-stat-row"><span>Checked</span><span class="comms-stat-val" id="dedup-checked">0</span></div>
      <div class="comms-stat-row"><span>Blocked</span><span class="comms-stat-val" style="color:var(--orange)" id="dedup-blocked">0</span></div>
      <div class="comms-stat-row"><span>Dedup Rate</span><span class="comms-stat-val" id="dedup-rate">0%</span></div>
    </div>
    <div class="comms-stat-card">
      <div class="comms-stat-title">Topics</div>
      <div id="bus-topics"></div>
    </div>
  </div>
</div>

<script>
let snapshot = null;
let eventSource = null;
let agentNames = {};
let commsFilter = 'all';
let commsAgentFilter = null;
let busMessages = [];
const MAX_BUS_MESSAGES = 200;

// Agent colors for message display
const agentColors = {
  'stream-observer': 'var(--cyan)',
  'signal-classifier': 'var(--green)',
  'liquidation-detector': 'var(--red)',
  'sentiment-analyzer': 'var(--orange)',
  'anomaly-hunter': 'var(--purple)',
  'rbi-researcher': 'var(--blue)',
  'rbi-backtester': 'var(--cyan)',
  'rbi-implementer': 'var(--orange)',
  'risk-manager': 'var(--red)',
  'polymarket-analyst': 'var(--purple)',
  'queen': 'var(--yellow)',
};

// Load agent names from server
function loadAgentNames() {
  fetch('/api/agents/names').then(r=>r.json()).then(names => {
    agentNames = names;
    renderCommsAgents();
  }).catch(()=>{});
}

function getAgentName(id) {
  return (agentNames[id] && agentNames[id].name) || id;
}

function getAgentAvatar(id) {
  return (agentNames[id] && agentNames[id].avatar) || '??';
}

function connect() {
  eventSource = new EventSource('/api/events');
  eventSource.onopen = () => {
    document.getElementById('conn-dot').className = 'connected-dot live';
    document.getElementById('conn-text').textContent = 'Live';
  };
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'init') {
        snapshot = data.snapshot;
        render();
        renderBusStats();
      } else if (data.type === 'bus-message') {
        appendBusMessage(data);
      } else {
        appendEvent(data);
        // Refresh full state periodically
        fetch('/api/snapshot').then(r=>r.json()).then(s => { snapshot = s; render(); renderBusStats(); }).catch(()=>{});
      }
    } catch {}
  };
  eventSource.onerror = () => {
    document.getElementById('conn-dot').className = 'connected-dot dead';
    document.getElementById('conn-text').textContent = 'Disconnected';
    setTimeout(connect, 3000);
  };
}

function render() {
  if (!snapshot) return;
  const s = snapshot;

  // Queen state
  const stateEl = document.getElementById('queen-state');
  stateEl.textContent = s.state.toUpperCase().replace('-', ' ');
  stateEl.className = 'status-badge status-' + s.state;

  // Top stats
  document.getElementById('stat-uptime').textContent = formatUptime(s.uptime);
  document.getElementById('stat-nodes').textContent = s.fleet.healthyNodes + '/' + s.fleet.totalNodes;
  document.getElementById('stat-inferences').textContent = s.fleet.totalInferences.toLocaleString();
  document.getElementById('stat-local').textContent = s.tierStats.local.calls.toLocaleString();
  document.getElementById('stat-freeapi').textContent = s.tierStats.freeApi.calls.toLocaleString();
  document.getElementById('stat-paidapi').textContent = '$' + s.tierStats.paidApi.costUsd.toFixed(2);
  const riskEl = document.getElementById('stat-risk');
  riskEl.textContent = s.portfolio.riskLevel;
  riskEl.className = 'stat-value ' + (s.portfolio.riskLevel === 'LOW' ? 'stat-green' : s.portfolio.riskLevel === 'CRITICAL' ? 'stat-red' : '');

  // Nodes
  const grid = document.getElementById('nodes-grid');
  grid.innerHTML = s.fleet.nodes.map(n => renderNode(n, s.agents)).join('');

  // Agents table
  const tbody = document.getElementById('agents-tbody');
  tbody.innerHTML = s.agents.map(a => renderAgentRow(a)).join('');

  // RBI pipeline
  renderRbi(s.rbiPipeline);

  // Events
  if (s.recentEvents && s.recentEvents.length > 0) {
    const log = document.getElementById('event-log');
    if (log.children.length === 0) {
      log.innerHTML = s.recentEvents.slice(-30).map(e => renderEvent(e)).join('');
      log.scrollTop = log.scrollHeight;
    }
  }
}

function renderNode(n, agents) {
  const roleColors = { sentinel: 'cyan', strategist: 'purple', coder: 'orange', queen: 'yellow' };
  const agentChips = (n.assignedAgents || []).map(aId => {
    const a = agents.find(x => x.agentId === aId);
    const cls = a ? (a.status === 'running' ? 'running' : a.status === 'error' ? 'error' : '') : '';
    return '<span class="agent-chip ' + cls + '">' + aId + '</span>';
  }).join('');
  const modelTags = (n.loadedModels || []).map(m => '<span class="model-tag">' + m + '</span>').join(' ');

  return '<div class="card node-card">' +
    '<div class="role-tag role-' + n.role + '">' + n.role + '</div>' +
    '<div style="margin-top:8px"><span class="node-health ' + (n.healthy ? 'healthy' : 'unhealthy') + '"></span>' +
    '<span class="node-name">' + n.name + '</span></div>' +
    '<div class="node-host">' + n.host + '</div>' +
    '<div class="node-stat"><span class="label">Load</span><span>' + n.load + '</span></div>' +
    '<div class="node-stat"><span class="label">GPU</span><span>' + n.gpu + '</span></div>' +
    '<div class="node-stat"><span class="label">Inferences</span><span>' + n.totalInferences + '</span></div>' +
    (n.lastError ? '<div class="node-stat"><span class="label">Error</span><span style="color:var(--red)">' + n.lastError + '</span></div>' : '') +
    (modelTags ? '<div style="margin-top:6px">' + modelTags + '</div>' : '') +
    '<div class="agent-list">' + agentChips + '</div>' +
    '</div>';
}

function renderAgentRow(a) {
  const colors = { running: 'var(--green)', idle: 'var(--dim)', error: 'var(--red)', stopped: 'var(--dim)' };
  const lastRun = a.lastRunAt ? new Date(a.lastRunAt).toLocaleTimeString() : '--';
  const displayName = getAgentName(a.agentId);
  return '<tr>' +
    '<td style="font-weight:600">' + displayName + ' <span style="font-size:9px;color:var(--dim);font-weight:400">' + a.agentId + '</span></td>' +
    '<td>' + (a.nodeId || '--') + '</td>' +
    '<td style="color:' + (colors[a.status]||'var(--dim)') + '">' + a.status + '</td>' +
    '<td>' + a.runCount + (a.errorCount > 0 ? ' <span style="color:var(--red)">(' + a.errorCount + ' err)</span>' : '') + '</td>' +
    '<td style="color:var(--dim)">' + lastRun + '</td>' +
    '</tr>';
}

function renderRbi(rbi) {
  const stages = ['research', 'backtest', 'implement'];
  const els = [['rbi-r','rbi-l1'], ['rbi-b','rbi-l2'], ['rbi-i']];
  const stageIndex = rbi.stage ? stages.indexOf(rbi.stage) : -1;

  els.forEach(([dotId, lineId], i) => {
    const dot = document.getElementById(dotId);
    if (i < stageIndex) { dot.className = 'pipeline-dot done'; }
    else if (i === stageIndex) { dot.className = 'pipeline-dot active'; }
    else { dot.className = 'pipeline-dot'; }

    if (lineId) {
      const line = document.getElementById(lineId);
      line.className = i < stageIndex ? 'pipeline-line done' : 'pipeline-line';
    }
  });

  document.getElementById('rbi-status').textContent =
    rbi.status === 'idle' ? 'Idle — waiting for research trigger' :
    rbi.status + (rbi.currentStrategyId ? ' (' + rbi.currentStrategyId + ')' : '');
  document.getElementById('rbi-progress').style.width = rbi.progress + '%';
}

function appendEvent(e) {
  const log = document.getElementById('event-log');
  const html = renderEvent(e);
  log.insertAdjacentHTML('beforeend', html);
  if (log.children.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function renderEvent(e) {
  const time = new Date(e.timestamp).toLocaleTimeString();
  const typeColors = {
    'health-check': 'var(--dim)', 'task-routed': 'var(--cyan)',
    'task-completed': 'var(--green)', 'node-down': 'var(--red)',
    'node-recovered': 'var(--green)', 'queen-directive': 'var(--yellow)'
  };
  let detail = '';
  if (e.type === 'task-routed') detail = e.taskType + ' → ' + e.route.provider + '/' + e.route.model;
  else if (e.type === 'task-completed') detail = e.taskType + ' on ' + e.nodeId + ' (' + e.durationMs + 'ms)';
  else if (e.type === 'node-down') detail = e.nodeId + ': ' + e.error;
  else if (e.type === 'node-recovered') detail = e.nodeId + ' back online';
  else if (e.type === 'queen-directive') detail = e.action + ': ' + e.reason;
  else if (e.type === 'health-check') detail = e.nodes.filter(n=>n.healthy).length + '/' + e.nodes.length + ' nodes healthy';

  return '<div class="event-entry">' +
    '<span class="event-time">' + time + '</span>' +
    '<span class="event-type" style="color:' + (typeColors[e.type]||'var(--text)') + '">' + e.type + '</span>' +
    '<span>' + detail + '</span></div>';
}

function formatUptime(ms) {
  if (!ms) return '--';
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s%60) + 's';
}

function sendCmd(action) {
  fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  }).then(r=>r.json()).then(()=>{
    fetch('/api/snapshot').then(r=>r.json()).then(s => { snapshot = s; render(); });
  }).catch(err => alert('Command failed: ' + err));
}

// --- Agent Comms Functions ---

function renderCommsAgents() {
  const el = document.getElementById('comms-agents');
  if (!el) return;
  const agents = snapshot ? snapshot.agents : [];
  const ids = agents.map(a => a.agentId);
  // Always include queen
  if (!ids.includes('queen')) ids.unshift('queen');

  el.innerHTML = ids.map(id => {
    const a = agents.find(x => x.agentId === id);
    const status = a ? a.status : 'idle';
    const isActive = status === 'running';
    const selected = commsAgentFilter === id ? ' selected' : '';
    const color = agentColors[id] || 'var(--dim)';
    const name = getAgentName(id);
    const avatar = getAgentAvatar(id);
    return '<div class="comms-agent' + selected + '" onclick="filterByAgent(\\''+id+'\\')" ondblclick="startRename(\\''+id+'\\')">' +
      '<div class="comms-avatar" style="background:' + color + ';color:var(--bg)">' + avatar + '</div>' +
      '<div class="comms-agent-info">' +
        '<div class="comms-agent-name" id="agent-name-' + id + '">' + name + '</div>' +
        '<div class="comms-agent-id">' + id + '</div>' +
      '</div>' +
      '<span class="comms-agent-badge ' + (isActive ? 'active' : 'idle') + '">' + (isActive ? 'ON' : 'OFF') + '</span>' +
    '</div>';
  }).join('');
}

function filterByAgent(agentId) {
  if (commsAgentFilter === agentId) {
    commsAgentFilter = null;
    document.getElementById('comms-feed-title').textContent = 'All Messages';
  } else {
    commsAgentFilter = agentId;
    document.getElementById('comms-feed-title').textContent = getAgentName(agentId) + ' Messages';
  }
  renderCommsAgents();
  renderCommsMessages();
}

function startRename(agentId) {
  const nameEl = document.getElementById('agent-name-' + agentId);
  if (!nameEl) return;
  const current = getAgentName(agentId);
  nameEl.innerHTML = '<input type="text" value="' + current + '" onblur="finishRename(\\''+agentId+'\\', this.value)" onkeydown="if(event.key===\\'Enter\\')this.blur()" autofocus>';
  nameEl.querySelector('input').select();
}

function finishRename(agentId, newName) {
  if (!newName || newName.trim() === '') {
    renderCommsAgents();
    return;
  }
  fetch('/api/agents/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, customName: newName.trim() })
  }).then(r => r.json()).then(res => {
    if (res.ok) {
      if (agentNames[agentId]) agentNames[agentId].name = newName.trim();
      renderCommsAgents();
      // Re-render agent table too
      if (snapshot) {
        const tbody = document.getElementById('agents-tbody');
        tbody.innerHTML = snapshot.agents.map(a => renderAgentRow(a)).join('');
      }
    }
  }).catch(() => renderCommsAgents());
}

function setCommsFilter(filter) {
  commsFilter = filter;
  // Update filter buttons
  document.querySelectorAll('.comms-feed-filter button').forEach(btn => {
    btn.className = btn.textContent.toLowerCase() === filter ? 'active' : '';
  });
  renderCommsMessages();
}

function getTopicCategory(topic) {
  if (!topic) return 'system';
  if (topic.startsWith('signals.')) return 'signals';
  if (topic.startsWith('rbi.')) return 'rbi';
  if (topic.startsWith('risk.')) return 'risk';
  if (topic.startsWith('analysis.')) return 'analysis';
  if (topic.startsWith('system.')) return 'system';
  if (topic.startsWith('direct.')) return 'direct';
  return 'system';
}

function appendBusMessage(msg) {
  busMessages.push(msg);
  if (busMessages.length > MAX_BUS_MESSAGES) busMessages.shift();
  // Only append to DOM if it passes the current filter
  if (shouldShowMessage(msg)) {
    const container = document.getElementById('comms-messages');
    // Clear placeholder
    if (container.children.length === 1 && container.children[0].style.textAlign === 'center') {
      container.innerHTML = '';
    }
    container.insertAdjacentHTML('beforeend', renderBusMsg(msg));
    if (container.children.length > 150) container.removeChild(container.firstChild);
    container.scrollTop = container.scrollHeight;
  }
}

function shouldShowMessage(msg) {
  const cat = getTopicCategory(msg.topic);
  if (commsFilter !== 'all' && cat !== commsFilter) return false;
  if (commsAgentFilter && msg.from !== commsAgentFilter && msg.to !== commsAgentFilter) return false;
  return true;
}

function renderCommsMessages() {
  const container = document.getElementById('comms-messages');
  const filtered = busMessages.filter(shouldShowMessage);
  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dim);font-size:11px">No messages matching filter</div>';
    return;
  }
  container.innerHTML = filtered.slice(-100).map(renderBusMsg).join('');
  container.scrollTop = container.scrollHeight;
}

function renderBusMsg(msg) {
  const cat = getTopicCategory(msg.topic);
  const fromName = getAgentName(msg.from);
  const fromColor = agentColors[msg.from] || 'var(--dim)';
  const toName = msg.to ? getAgentName(msg.to) : '';
  const toColor = msg.to ? (agentColors[msg.to] || 'var(--dim)') : '';
  const time = new Date(msg.timestamp).toLocaleTimeString();
  const topicShort = (msg.topic || '').split('.').pop();

  return '<div class="comms-msg topic-' + cat + '">' +
    '<div class="comms-msg-header">' +
      '<div>' +
        '<span class="comms-msg-from" style="color:' + fromColor + '">' + fromName + '</span>' +
        (msg.to ? '<span class="comms-msg-arrow">-></span><span class="comms-msg-to" style="color:' + toColor + '">' + toName + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<span class="comms-msg-topic">' + topicShort + '</span>' +
        '<span class="comms-msg-time">' + time + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="comms-msg-summary">' + (msg.summary || '') + '</div>' +
    (msg.inReplyTo ? '<div class="comms-msg-chain">reply to ' + msg.inReplyTo + '</div>' : '') +
  '</div>';
}

function renderBusStats() {
  if (!snapshot) return;
  const bus = snapshot.messageBus;
  const dedup = snapshot.signalDedup;
  if (bus) {
    document.getElementById('bus-published').textContent = bus.totalPublished.toLocaleString();
    document.getElementById('bus-delivered').textContent = bus.totalDelivered.toLocaleString();
    document.getElementById('bus-dropped').textContent = bus.totalDropped.toLocaleString();
    document.getElementById('bus-subs').textContent = bus.activeSubscriptions;
    document.getElementById('bus-history').textContent = bus.historySize.toLocaleString();
    document.getElementById('bus-context').textContent = bus.contextSize.toLocaleString();

    // Topic bars
    const topicsEl = document.getElementById('bus-topics');
    const topics = bus.topicCounts || {};
    const maxCount = Math.max(1, ...Object.values(topics));
    topicsEl.innerHTML = Object.entries(topics)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, c]) => {
        const pct = Math.round((c / maxCount) * 100);
        return '<div class="topic-bar">' +
          '<span class="topic-bar-label">' + t.split('.').pop() + '</span>' +
          '<div style="flex:1"><div class="topic-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="topic-bar-count">' + c + '</span>' +
        '</div>';
      }).join('');
  }
  if (dedup) {
    document.getElementById('dedup-checked').textContent = dedup.totalChecked.toLocaleString();
    document.getElementById('dedup-blocked').textContent = dedup.duplicatesBlocked.toLocaleString();
    document.getElementById('dedup-rate').textContent = dedup.dedupRate;
  }

  // Also update agent list with latest state
  renderCommsAgents();
}

// Poll full state every 15s as backup to SSE
setInterval(() => {
  fetch('/api/snapshot').then(r=>r.json()).then(s => { snapshot = s; render(); renderBusStats(); }).catch(()=>{});
}, 15000);

loadAgentNames();
connect();
</script>
</body>
</html>`;
