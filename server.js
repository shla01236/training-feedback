const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Credentials (edit here to change login) ─────────────────────────────────
const ACCOUNTS = [
  { username: 'admin',   password: 'training2025' },
  { username: 'trainer', password: 'feedback123'  },
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'feedback-tool-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// Auth middleware — protects admin pages, passes through submit/board pages
function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// ─── Login ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const error = req.query.error;
  const next = req.query.next || '/';
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 - 培训反馈收集</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:#f5f5f7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:20px;padding:44px 40px;width:100%;max-width:400px;box-shadow:0 4px 32px rgba(0,0,0,.1)}
  .logo{width:52px;height:52px;background:linear-gradient(135deg,#0071e3,#34aadc);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.6rem;margin:0 auto 24px}
  h1{font-size:1.5rem;font-weight:700;text-align:center;color:#1d1d1f;margin-bottom:6px}
  .sub{text-align:center;color:#86868b;font-size:0.88rem;margin-bottom:32px}
  .field{margin-bottom:16px}
  label{display:block;font-size:0.78rem;font-weight:600;color:#86868b;letter-spacing:.5px;margin-bottom:6px}
  input{width:100%;background:#f5f5f7;border:1.5px solid transparent;border-radius:10px;padding:13px 14px;font-size:0.98rem;outline:none;transition:all .2s;font-family:inherit;color:#1d1d1f}
  input:focus{background:#fff;border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.12)}
  .error{background:#fff2f2;border:1px solid #ffd0d0;color:#c0392b;font-size:0.83rem;padding:10px 14px;border-radius:8px;margin-bottom:16px;display:flex;align-items:center;gap:6px}
  .btn{width:100%;padding:14px;background:#0071e3;border:none;border-radius:10px;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;margin-top:8px;transition:all .15s}
  .btn:hover{background:#0077ed}
  .btn:active{transform:scale(.98)}
  .hint{text-align:center;font-size:0.75rem;color:#c7c7cc;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">💬</div>
  <h1>培训反馈收集</h1>
  <p class="sub">请登录以管理反馈收集</p>
  ${error ? `<div class="error">⚠ 账号或密码错误，请重试</div>` : ''}
  <form method="POST" action="/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <div class="field">
      <label>账号</label>
      <input type="text" name="username" placeholder="输入账号" autocomplete="username" autofocus required>
    </div>
    <div class="field">
      <label>密码</label>
      <input type="password" name="password" placeholder="输入密码" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn">登录</button>
  </form>
  <p class="hint">登录状态保持 8 小时</p>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password, next } = req.body;
  const ok = ACCOUNTS.some(a => a.username === username && a.password === password);
  if (!ok) return res.redirect('/login?error=1&next=' + encodeURIComponent(next || '/'));
  req.session.loggedIn = true;
  req.session.username = username;
  res.redirect(next || '/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// sessions: { id, topic, words: {word: count}, clients: Set, createdAt }
const sessions = {};
const sessionOrder = []; // ordered list of ids

function createSession(topic) {
  const id = uuidv4().replace(/-/g, '').slice(0, 12);
  sessions[id] = { id, topic: topic || '未命名收集', words: {}, clients: new Set(), createdAt: Date.now() };
  sessionOrder.unshift(id);
  return id;
}

function getWordList(sessionId) {
  const s = sessions[sessionId];
  if (!s) return [];
  return Object.entries(s.words).map(([text, weight]) => [text, weight]);
}

function broadcast(sessionId, data) {
  const s = sessions[sessionId];
  if (!s) return;
  const msg = JSON.stringify(data);
  s.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session');
  if (!sessionId || !sessions[sessionId]) { ws.close(); return; }
  sessions[sessionId].clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', words: getWordList(sessionId) }));
  ws.on('close', () => { if (sessions[sessionId]) sessions[sessionId].clients.delete(ws); });
});

// ─── Pages ────────────────────────────────────────────────────────────────────

// Session list / home
app.get('/', requireAuth, (req, res) => {
  const list = sessionOrder.map(id => sessions[id]).filter(Boolean);
  const rows = list.map(s => {
    const count = Object.values(s.words).reduce((a, b) => a + b, 0);
    const date = new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<tr onclick="location.href='/board/${s.id}'" style="cursor:pointer">
      <td><span class="topic-badge">${esc(s.topic)}</span></td>
      <td class="mono">${s.id}</td>
      <td>${count} 条</td>
      <td class="muted">${date}</td>
      <td>
        <a href="/board/${s.id}" onclick="event.stopPropagation()" class="link-btn">白板</a>
        <a href="/submit/${s.id}" onclick="event.stopPropagation()" class="link-btn">提交页</a>
        <a href="javascript:void(0)" onclick="event.stopPropagation();confirmDelete('${s.id}','${esc(s.topic)}')" class="link-btn link-danger">删除</a>
      </td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>反馈收集 - 管理</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:#f5f5f7;color:#1d1d1f;min-height:100vh}
  .topbar{background:#fff;border-bottom:1px solid #e5e5ea;padding:0 40px;height:56px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{font-size:1.1rem;font-weight:600;color:#1d1d1f}
  .btn{padding:8px 20px;border-radius:8px;border:none;font-size:0.9rem;cursor:pointer;font-weight:500;transition:all .15s;text-decoration:none;display:inline-block}
  .btn-primary{background:#0071e3;color:#fff}
  .btn-primary:hover{background:#0077ed}
  .btn-ghost{background:transparent;color:#86868b;border:1px solid #e5e5ea}
  .btn-ghost:hover{background:#f5f5f7}
  .main{max-width:960px;margin:40px auto;padding:0 24px}
  .section-title{font-size:1.4rem;font-weight:600;margin-bottom:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th{padding:12px 20px;text-align:left;font-size:0.78rem;font-weight:600;color:#86868b;background:#fafafa;border-bottom:1px solid #f0f0f0;letter-spacing:.5px;text-transform:uppercase}
  td{padding:14px 20px;border-bottom:1px solid #f5f5f7;font-size:0.9rem;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  .topic-badge{background:#e8f0fe;color:#1a73e8;padding:4px 10px;border-radius:6px;font-weight:500;font-size:0.85rem}
  .mono{font-family:monospace;font-size:0.8rem;color:#86868b}
  .muted{color:#86868b;font-size:0.82rem}
  .link-btn{color:#0071e3;text-decoration:none;font-size:0.82rem;margin-right:10px;font-weight:500}
  .link-btn:hover{text-decoration:underline}
  .link-danger{color:#c0392b !important}
  .link-danger:hover{color:#e74c3c !important}
  .empty{text-align:center;padding:60px;color:#86868b}
  /* Modal */
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.3);backdrop-filter:blur(4px);align-items:center;justify-content:center;z-index:100}
  .modal-bg.open{display:flex}
  .modal{background:#fff;border-radius:20px;padding:36px;width:420px;box-shadow:0 20px 60px rgba(0,0,0,.2)}
  .modal h2{font-size:1.2rem;font-weight:600;margin-bottom:8px}
  .modal p{color:#86868b;font-size:0.88rem;margin-bottom:24px}
  .modal input{width:100%;border:1.5px solid #e5e5ea;border-radius:10px;padding:12px 14px;font-size:1rem;outline:none;font-family:inherit;color:#1d1d1f;transition:border-color .2s}
  .modal input:focus{border-color:#0071e3}
  .modal-footer{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
  .btn-cancel{background:#f5f5f7;color:#1d1d1f}
  .btn-cancel:hover{background:#e5e5ea}
</style>
</head>
<body>
<div class="topbar">
  <h1>培训反馈收集</h1>
  <div style="display:flex;align-items:center;gap:12px">
    <span style="font-size:0.82rem;color:#86868b">${esc(req.session.username)}</span>
    <form method="POST" action="/logout" style="display:inline;margin:0"><button type="submit" class="btn btn-ghost">退出</button></form>
    <button class="btn btn-primary" onclick="openModal()">+ 新建收集</button>
  </div>
</div>
<div class="main">
  <div class="section-title">收集列表</div>
  <div class="card">
    ${list.length ? `<table>
      <thead><tr><th>话题</th><th>Session ID</th><th>反馈数</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<div class="empty">暂无收集，点击右上角新建</div>'}
  </div>
</div>

<!-- 新建收集弹窗 -->
<div class="modal-bg" id="modal">
  <div class="modal">
    <h2>新建反馈收集</h2>
    <p>输入本次收集的话题，将显示在白板顶部</p>
    <input id="topicInput" type="text" placeholder="例：今天最大的收获是什么？" maxlength="50" autofocus>
    <div class="modal-footer">
      <button class="btn btn-cancel" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="createSession()">创建并打开白板</button>
    </div>
  </div>
</div>

<!-- 删除确认弹窗 -->
<div class="modal-bg" id="deleteModal">
  <div class="modal">
    <h2>删除收集</h2>
    <p id="deleteModalDesc" style="margin-bottom:20px"></p>
    <div style="background:#fff5f5;border:1px solid #ffd0d0;border-radius:10px;padding:12px 16px;font-size:0.85rem;color:#c0392b;margin-bottom:8px">
      ⚠️ 删除后所有反馈数据将无法恢复
    </div>
    <div class="modal-footer" style="margin-top:16px">
      <button class="btn btn-cancel" onclick="closeDeleteModal()">取消</button>
      <button class="btn" id="confirmDeleteBtn" style="background:#c0392b;color:#fff" onclick="doDelete()">确认删除</button>
    </div>
  </div>
</div>

<script>
  // ── 新建弹窗 ──
  function openModal(){document.getElementById('modal').classList.add('open');document.getElementById('topicInput').focus()}
  function closeModal(){document.getElementById('modal').classList.remove('open')}
  document.getElementById('modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeModal() })
  document.getElementById('topicInput').addEventListener('keydown', e => { if(e.key==='Enter') createSession() })
  function createSession(){
    const topic = document.getElementById('topicInput').value.trim() || '未命名收集';
    fetch('/api/session/new', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({topic})})
      .then(r=>r.json()).then(d=>{ window.open('/board/'+d.id,'_blank'); location.reload(); });
  }

  // ── 删除弹窗 ──
  let _deleteId = null;
  function confirmDelete(id, topic) {
    _deleteId = id;
    document.getElementById('deleteModalDesc').textContent = '确定要删除「' + topic + '」吗？';
    document.getElementById('deleteModal').classList.add('open');
  }
  function closeDeleteModal() {
    _deleteId = null;
    document.getElementById('deleteModal').classList.remove('open');
  }
  document.getElementById('deleteModal').addEventListener('click', e => { if(e.target===e.currentTarget) closeDeleteModal() })
  function doDelete() {
    if (!_deleteId) return;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.textContent = '删除中…';
    fetch('/api/session/' + _deleteId, {method:'DELETE'})
      .then(r => r.json()).then(d => {
        if (d.ok) location.reload();
        else { btn.disabled=false; btn.textContent='确认删除'; }
      });
  }
</script>
</body>
</html>`);
});

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Delete session API
app.delete('/api/session/:sessionId', requireAuth, (req, res) => {
  const sid = req.params.sessionId;
  if (!sessions[sid]) return res.json({ ok: false, error: 'Not found' });
  // close all connected WebSocket clients
  sessions[sid].clients.forEach(ws => ws.close());
  delete sessions[sid];
  const idx = sessionOrder.indexOf(sid);
  if (idx !== -1) sessionOrder.splice(idx, 1);
  res.json({ ok: true });
});

// Create new session API
app.post('/api/session/new', requireAuth, (req, res) => {
  const topic = (req.body.topic || '').trim() || '未命名收集';
  const id = createSession(topic);
  res.json({ id, topic });
});

// ─── Board (whiteboard + QR) ─────────────────────────────────────────────────
app.get('/board/:sessionId', async (req, res) => {
  const sid = req.params.sessionId;
  if (!sessions[sid]) return res.status(404).send('Session not found');
  const s = sessions[sid];
  const host = req.headers.host;
  const submitUrl = `http://${host}/submit/${sid}`;
  const qrDataUrl = await QRCode.toDataURL(submitUrl, { width: 400, margin: 2, color: { dark: '#1a1a2e', light: '#f7f7fa' } });

  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(s.topic)} - 反馈白板</title>
<script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.min.js"><\/script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#f7f7fa;width:100vw;height:100vh;overflow:hidden;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;display:flex;flex-direction:row}

  /* ── Left: main area (75%) ── */
  .cloud-col{flex:3;display:flex;flex-direction:column;min-width:0;border-right:1px solid #ebebef}

  .topic-bar{flex-shrink:0;padding:18px 32px 14px;background:#fff;border-bottom:1px solid #ebebef;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .topic-left{min-width:0;flex:1}
  .topic-label{font-size:0.7rem;font-weight:600;color:#b0b0bc;letter-spacing:2px;text-transform:uppercase;margin-bottom:5px}
  .topic-text{font-size:2rem;font-weight:800;color:#1a1a2e;line-height:1.2;letter-spacing:-0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* view toggle */
  .view-toggle{flex-shrink:0;display:flex;background:#f0f0f5;border-radius:10px;padding:3px;gap:2px}
  .toggle-btn{padding:6px 16px;border:none;background:transparent;border-radius:8px;font-size:0.82rem;font-weight:600;color:#86868b;cursor:pointer;transition:all .15s;white-space:nowrap}
  .toggle-btn.active{background:#fff;color:#1a1a2e;box-shadow:0 1px 4px rgba(0,0,0,.1)}

  /* cloud view */
  .cloud-area{flex:1;position:relative;background:#fff;display:flex}
  canvas{display:block;position:absolute;inset:0}
  .empty-hint{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;pointer-events:none}
  .empty-hint .big{font-size:2rem;font-weight:700;color:#dddde3}
  .empty-hint .small{font-size:0.9rem;color:#c7c7d0}

  /* list view */
  .list-area{flex:1;background:#fff;overflow-y:auto;padding:24px 32px;display:none}
  .list-area.active{display:block}
  .list-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;align-content:start}
  .list-item{background:#fafaf8;border:1px solid #f0ece6;border-radius:12px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .list-word{font-size:1.1rem;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .list-badge{flex-shrink:0;background:#1a1a2e;color:#fff;font-size:0.75rem;font-weight:700;padding:3px 10px;border-radius:20px;min-width:36px;text-align:center}
  .list-empty{text-align:center;padding:60px;color:#dddde3;font-size:1.2rem;font-weight:600}

  /* ── Right: QR panel (25%) ── */
  .qr-col{flex:1;min-width:200px;max-width:320px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 24px;background:#f7f7fa}
  .qr-img-wrap{background:#fff;border-radius:20px;padding:16px;box-shadow:0 2px 20px rgba(0,0,0,.07)}
  .qr-img-wrap img{display:block;width:100%;max-width:220px;height:auto;border-radius:8px}
  .qr-label{font-size:1rem;font-weight:600;color:#1a1a2e;text-align:center;letter-spacing:.2px}
  .qr-sub{font-size:0.78rem;color:#b0b0bc;text-align:center;line-height:1.5}
  .qr-count{background:#1a1a2e;color:#fff;font-size:0.8rem;font-weight:600;padding:6px 16px;border-radius:20px;letter-spacing:.3px}
  .qr-url{font-size:0.62rem;color:#c7c7d0;font-family:monospace;text-align:center;word-break:break-all;line-height:1.5;max-width:200px}
</style>
</head>
<body>

<div class="cloud-col">
  <div class="topic-bar">
    <div class="topic-left">
      <div class="topic-label">当前话题</div>
      <div class="topic-text">${esc(s.topic)}</div>
    </div>
    <div class="view-toggle">
      <button class="toggle-btn active" id="btnCloud" onclick="switchView('cloud')">词云</button>
      <button class="toggle-btn" id="btnList" onclick="switchView('list')">列表</button>
    </div>
  </div>
  <div class="cloud-area" id="cloudArea">
    <canvas id="canvas"></canvas>
    <div class="empty-hint" id="empty">
      <div class="big">等待反馈中…</div>
      <div class="small">请扫描右侧二维码提交想法</div>
    </div>
  </div>
  <div class="list-area" id="listArea">
    <div class="list-grid" id="listGrid"></div>
  </div>
</div>

<div class="qr-col">
  <div class="qr-img-wrap">
    <img src="${qrDataUrl}" alt="QR Code">
  </div>
  <div class="qr-label">扫码提交反馈</div>
  <div class="qr-sub">打开手机相机<br>对准二维码即可参与</div>
  <div class="qr-count" id="cnt">0 条反馈</div>
  <div class="qr-url">${submitUrl}</div>
</div>

<script>
  const canvas   = document.getElementById('canvas');
  const empty    = document.getElementById('empty');
  const cnt      = document.getElementById('cnt');
  const cloudArea = document.getElementById('cloudArea');
  const listArea  = document.getElementById('listArea');
  const listGrid  = document.getElementById('listGrid');

  // Maillard palette
  const PALETTE = [
    '#7B3F00','#A0522D','#C4773B','#B85C38','#C8882A',
    '#8B6914','#D4874E','#964B2A','#6B3A2A','#B8763A',
    '#9E4A1E','#C9973A','#7A4419','#D4A04A','#855C3A','#A86B2D',
  ];
  function wordColor(word) {
    return PALETTE[Math.abs(word.split('').reduce((a,c) => a + c.charCodeAt(0), 0)) % PALETTE.length];
  }

  // ── View toggle ──────────────────────────────────────────────────────────────
  let currentView = 'cloud';
  function switchView(v) {
    currentView = v;
    document.getElementById('btnCloud').classList.toggle('active', v === 'cloud');
    document.getElementById('btnList').classList.toggle('active', v === 'list');
    if (v === 'cloud') {
      cloudArea.style.display = 'flex';
      listArea.classList.remove('active');
      resize(); renderCloud();
    } else {
      cloudArea.style.display = 'none';
      listArea.classList.add('active');
      renderList();
    }
  }

  // ── Word cloud ───────────────────────────────────────────────────────────────
  function resize() {
    canvas.width  = cloudArea.offsetWidth;
    canvas.height = cloudArea.offsetHeight;
  }
  resize();
  window.addEventListener('resize', () => { resize(); if (currentView === 'cloud') renderCloud(); });

  let wordData = [];

  function renderCloud() {
    if (!wordData.length) { empty.style.display='flex'; canvas.style.display='none'; return; }
    empty.style.display = 'none';
    canvas.style.display = 'block';

    const maxCount = Math.max(...wordData.map(([,c]) => c));
    const w = canvas.width, h = canvas.height;
    // Tighter packing: smaller gridSize + minSize to fit more words
    const gridSize = Math.max(4, Math.round(8 * w / 1400));

    WordCloud(canvas, {
      list: wordData,
      gridSize,
      weightFactor: weight => {
        const base = Math.min(w, h) / 12;
        return Math.max(14, base * (0.45 + Math.sqrt(weight - 1) * 0.42));
      },
      fontFamily: 'PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif',
      fontWeight: '800',
      color: word => wordColor(word),
      rotateRatio: 0,
      rotationSteps: 1,
      backgroundColor: '#ffffff',
      drawOutOfBound: false,
      minSize: 10,
      shrinkToFit: true,
    });
  }

  // ── List view ────────────────────────────────────────────────────────────────
  function renderList() {
    if (!wordData.length) {
      listGrid.innerHTML = '<div class="list-empty">等待反馈中…</div>';
      return;
    }
    const sorted = [...wordData].sort((a, b) => b[1] - a[1]);
    listGrid.innerHTML = sorted.map(([word, count]) =>
      '<div class="list-item">' +
        '<span class="list-word" style="color:' + wordColor(word) + '">' + word + '</span>' +
        '<span class="list-badge">' + count + '</span>' +
      '</div>'
    ).join('');
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '?session=${sid}');
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.words !== undefined) {
      wordData = d.words;
      const total = d.words.reduce((s, [,c]) => s + c, 0);
      cnt.textContent = total + ' 条反馈';
      if (currentView === 'cloud') renderCloud();
      else renderList();
    }
  };
  ws.onclose = () => setTimeout(() => location.reload(), 3000);
<\/script>
</body>
</html>`);
});

// ─── Words API (for submit page live list) ────────────────────────────────────
app.get('/api/words/:sessionId', (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.json({ ok: false });
  const words = Object.entries(s.words)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count);
  res.json({ ok: true, words });
});

// ─── Submit page ─────────────────────────────────────────────────────────────
app.get('/submit/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  const s = sessions[sid];
  if (!s) return res.status(404).send(`
    <html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f7;color:#1d1d1f">
    <h2>该收集已结束</h2><p style="color:#86868b;margin-top:12px">请联系培训师获取新链接</p>
    </body></html>`);

  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>提交反馈</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:#f7f3ef;color:#1d1d1f;min-height:100vh;padding:20px 16px 40px}
  .header{max-width:480px;margin:0 auto 16px}
  .topic-chip{display:inline-block;background:#ecddd4;color:#7B3F00;padding:5px 12px;border-radius:20px;font-size:0.82rem;font-weight:600;margin-bottom:10px}
  h1{font-size:1.4rem;font-weight:700;color:#1d1d1f;margin-bottom:4px}
  .sub{color:#86868b;font-size:0.85rem}

  /* Input card */
  .input-card{background:#fff;border-radius:18px;padding:20px;max-width:480px;margin:0 auto 20px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .input-label{font-size:0.75rem;font-weight:600;color:#86868b;letter-spacing:.5px;margin-bottom:8px}
  .input-row{display:flex;gap:10px;align-items:flex-end}
  input[type=text]{flex:1;background:#f7f3ef;border:1.5px solid transparent;border-radius:10px;color:#1d1d1f;font-size:1rem;padding:11px 14px;outline:none;transition:all .2s;font-family:inherit}
  input[type=text]:focus{border-color:#C4773B;background:#fff}
  input[type=text]::placeholder{color:#c7c7cc}
  .btn-send{padding:11px 20px;background:#7B3F00;border:none;border-radius:10px;color:#fff;font-size:0.95rem;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s;flex-shrink:0}
  .btn-send:hover{background:#964B2A}
  .btn-send:active{transform:scale(.97)}
  .btn-send:disabled{opacity:.4;cursor:not-allowed;transform:none}

  /* Word list */
  .list-header{max-width:480px;margin:0 auto 10px;display:flex;align-items:center;justify-content:space-between}
  .list-title{font-size:0.75rem;font-weight:600;color:#86868b;letter-spacing:.5px}
  .list-count{font-size:0.75rem;color:#c7c7cc}
  .word-list{max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
  .word-row{background:#fff;border-radius:14px;padding:12px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 1px 6px rgba(0,0,0,.05);transition:all .2s}
  .word-row.mine{background:#fdf6f0;border:1.5px solid #ecddd4}
  .word-text{flex:1;font-size:1rem;font-weight:500;color:#1d1d1f;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .word-count{font-size:0.78rem;color:#86868b;font-weight:500;white-space:nowrap}
  .btn-plus{padding:5px 12px;background:#f7f3ef;border:1.5px solid #ecddd4;border-radius:8px;color:#7B3F00;font-size:0.82rem;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;flex-shrink:0}
  .btn-plus:hover{background:#ecddd4}
  .btn-plus.done{background:#7B3F00;border-color:#7B3F00;color:#fff;cursor:default}
  .btn-plus:disabled{opacity:.5;cursor:not-allowed}
  .empty-list{text-align:center;padding:32px;color:#c7c7cc;font-size:0.9rem}

  /* Toast */
  .toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(80px);background:#1d1d1f;color:#fff;padding:11px 24px;border-radius:40px;font-weight:500;font-size:0.9rem;transition:transform .35s cubic-bezier(.34,1.56,.64,1);pointer-events:none;white-space:nowrap;z-index:99}
  .toast.show{transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="header">
  <div class="topic-chip">${esc(s.topic)}</div>
  <h1>分享你的想法</h1>
  <p class="sub">输入后发送，或对已有内容点 +1 表示认同</p>
</div>

<div class="input-card">
  <div class="input-label">输入关键词或感受</div>
  <div class="input-row">
    <input type="text" id="input" placeholder="输入关键词、感受…" maxlength="30" autocomplete="off">
    <button class="btn-send" id="btn" onclick="submit()">发送</button>
  </div>
</div>

<div class="list-header">
  <span class="list-title">大家的反馈</span>
  <span class="list-count" id="totalCnt"></span>
</div>
<div class="word-list" id="wordList">
  <div class="empty-list">还没有反馈，来第一个吧</div>
</div>

<div class="toast" id="toast"></div>

<script>
  const sid = '${sid}';
  // track what this user has already +1'd or submitted
  const myVotes = new Set();
  let wordData = []; // [{text, count}]

  function renderList() {
    const el = document.getElementById('wordList');
    const tc = document.getElementById('totalCnt');
    const total = wordData.reduce((s, w) => s + w.count, 0);
    tc.textContent = total ? total + ' 条' : '';
    if (!wordData.length) {
      el.innerHTML = '<div class="empty-list">还没有反馈，来第一个吧</div>';
      return;
    }
    el.innerHTML = wordData.map(w => {
      const mine = myVotes.has(w.text);
      return '<div class="word-row' + (mine ? ' mine' : '') + '">' +
        '<span class="word-text">' + escHtml(w.text) + '</span>' +
        '<span class="word-count">' + w.count + ' 人</span>' +
        '<button class="btn-plus' + (mine ? ' done' : '') + '" ' +
          (mine ? 'disabled' : 'onclick="plusOne(\\''+escHtml(w.text)+'\\')"') +
          '>' + (mine ? '已认同' : '+1') + '</button>' +
        '</div>';
    }).join('');
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function plusOne(text) {
    if (myVotes.has(text)) return;
    myVotes.add(text);
    sendFeedback(text, '+1 已记录');
  }

  function submit() {
    const text = document.getElementById('input').value.trim();
    if (!text) return;
    document.getElementById('input').value = '';
    myVotes.add(text);
    sendFeedback(text, '已发送到白板');
  }

  function sendFeedback(text, toastMsg) {
    const btn = document.getElementById('btn');
    btn.disabled = true;
    fetch('/api/feedback/' + sid, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({text})
    }).then(r => r.json()).then(d => {
      if (d.ok) { showToast(toastMsg); renderList(); }
      btn.disabled = false;
    }).catch(() => { btn.disabled = false; });
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg + ' ✓';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  document.getElementById('input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  // Real-time updates via WebSocket
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '?session=' + sid);
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.words !== undefined) {
      wordData = d.words
        .map(([text, count]) => ({text, count}))
        .sort((a, b) => b.count - a.count);
      renderList();
    }
  };
  ws.onclose = () => setTimeout(() => location.reload(), 3000);
<\/script>
</body>
</html>`);
});

// ─── Feedback API ─────────────────────────────────────────────────────────────
app.post('/api/feedback/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  const s = sessions[sid];
  if (!s) return res.json({ ok: false, error: 'Session not found' });
  const text = (req.body.text || '').trim().slice(0, 30);
  if (!text) return res.json({ ok: false, error: 'Empty' });
  s.words[text] = (s.words[text] || 0) + 1;
  broadcast(sid, { type: 'update', words: getWordList(sid) });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ 反馈收集工具已启动`);
  console.log(`   管理页面: http://localhost:${PORT}\n`);
});
