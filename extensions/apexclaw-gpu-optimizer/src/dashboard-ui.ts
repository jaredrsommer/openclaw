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

<script>
let snapshot = null;
let eventSource = null;

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
      } else {
        appendEvent(data);
        // Refresh full state periodically
        fetch('/api/snapshot').then(r=>r.json()).then(s => { snapshot = s; render(); }).catch(()=>{});
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
  return '<tr>' +
    '<td style="font-weight:600">' + a.agentId + '</td>' +
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

// Poll full state every 15s as backup to SSE
setInterval(() => {
  fetch('/api/snapshot').then(r=>r.json()).then(s => { snapshot = s; render(); }).catch(()=>{});
}, 15000);

connect();
</script>
</body>
</html>`;
