/* 슬라임 관리판 — 기획서·일감·버그를 GitHub 이슈 위에서 관리하는 정적 페이지.
   데이터 원본은 GitHub 이슈(기획서 23·25장)이고, 이 페이지는 별도 저장소를 두지 않는다.
   빌드 없이 index.html 을 열거나 로컬 서버로 띄워 쓴다 (README.md 참조). */
'use strict';

// ── 기획서 v1.4 에서 온 값 ──────────────────────────────────────────
const STATUSES = ['백로그', '스펙완료', '설계중', '설계리뷰', '작업중', 'AI검증', '승인대기', '수정요청', '완료', '블록']; // 25-2
const PHASES = ['0b', '0c', '1', '2', '3', '4']; // 25-2
const AGENTS = ['pm', 'pd', 'ta', 'gameplay', 'systems', 'director', 'level', 'writer', 'qa']; // 19장
const AREAS = ['slime', 'element', 'tether', 'card', 'water', 'camera', 'light', 'level', 'story', 'infra', 'data', 'tutorial']; // 25-2
const PEOPLE = ['Wan', 'Dong']; // 18-1
const CHECKERS = ['Wan', 'Dong', '둘 다']; // 25-2
const PRIORITIES = ['P0', 'P1', 'P2']; // 25-2
const BUG_KINDS = ['bug', 'perf', 'feel', 'text']; // 29장 버그 라벨
const FLAGS = ['needs-design', 'design-approved', 'no-wan-check', 'data-only', 'agent-run', 'scene-lock']; // 20·23·26·29장
const ID_RE = /^\[([A-Z]{1,3}-\d{2}(?:-R\d+)?)\]\s*/;

// ── 라벨 이름 규칙 ──────────────────────────────────────────────────
// 23-1 에 있는 것: slime, phase-*, agent-*, area-*, needs-design 등.
// 이 페이지가 더한 것: status:*, owner:*, checker:*, P0~P2, 기획 (원래 Projects 필드: 25-2).
const L = {
  slime: 'slime',
  plan: '기획',
  status: s => `status:${s}`,
  phase: p => `phase-${p}`,
  agent: a => `agent-${a}`,
  area: a => `area-${a}`,
  owner: p => `owner:${p}`,
  checker: p => `checker:${p}`,
};
const LABEL_COLORS = { status: 'c5def5', phase: 'bfd4f2', agent: 'd4c5f9', area: 'e6f4ea', owner: 'fef2c0', checker: 'fbe5d6', pri: 'e99695', flag: 'ededed', kind: 'd73a4a', slime: '2f9e5f', plan: '0e8a16' };

function allLabelDefs() {
  const d = [[L.slime, LABEL_COLORS.slime, 'SlimeAdventure 일감 (필수, 23-1)'], [L.plan, LABEL_COLORS.plan, '기획서 의견·수정 요청']];
  STATUSES.forEach(s => d.push([L.status(s), LABEL_COLORS.status, 'Status (25-2)']));
  PHASES.forEach(p => d.push([L.phase(p), LABEL_COLORS.phase, 'Phase (25-2)']));
  AGENTS.forEach(a => d.push([L.agent(a), LABEL_COLORS.agent, '담당 AI (19장)']));
  AREAS.forEach(a => d.push([L.area(a), LABEL_COLORS.area, 'Area (25-2)']));
  PEOPLE.forEach(p => d.push([L.owner(p), LABEL_COLORS.owner, 'Owner (25-2)']));
  CHECKERS.forEach(p => d.push([L.checker(p), LABEL_COLORS.checker, 'Checker (25-2)']));
  PRIORITIES.forEach(p => d.push([p, LABEL_COLORS.pri, 'Priority (25-2)']));
  FLAGS.forEach(f => d.push([f, LABEL_COLORS.flag, '']));
  BUG_KINDS.forEach(k => d.push([k, LABEL_COLORS.kind, '버그 종류 (29장)']));
  return d;
}

// ── 설정 (localStorage, 실패해도 동작) ──────────────────────────────
const store = {
  get(k, d = '') { try { const v = localStorage.getItem('slimeMgr.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('slimeMgr.' + k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem('slimeMgr.' + k); } catch { /* 무시 */ } },
};
const cfg = () => ({
  repo: store.get('repo', 'DongDongLim/GameMaker'),
  branch: store.get('branch', 'main'),
  gh: store.get('gh'),
  me: store.get('me'),
});
const PLAN_DIR = 'SlimeAdventure/기획';

// ── 상태 ────────────────────────────────────────────────────────────
const S = { issues: [], prs: [], demo: false, planVersions: [], planSource: '', planTasks: [], current: null };

// ── 유틸 ────────────────────────────────────────────────────────────
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opt = (v, t = v, sel = false) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => { t.style.display = 'none'; }, ms); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('복사했습니다'); } catch { prompt('복사해서 쓰세요', text); } }
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// ── GitHub API ──────────────────────────────────────────────────────
async function gh(path, { method = 'GET', body, raw = false } = {}) {
  const c = cfg();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    // GitHub 응답은 브라우저가 60초 캐시한다 (max-age=60). 그러면 방금 바뀐 라벨·PR 이 새로고침해도 옛 값으로 나온다.
    cache: 'no-store',
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      Authorization: `Bearer ${c.gh}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* 본문 없음 */ }
    const err = new Error(explainGhError(res.status, method, path, msg));
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}
// GitHub 오류를 처음 쓰는 사람이 고칠 수 있는 말로 바꾼다 (guide.html 「안 될 때」와 같은 표현)
function explainGhError(status, method, path, msg) {
  const raw = `(GitHub ${status} ${msg})`;
  if (status === 429 || /rate limit/i.test(msg)) return `GitHub 이 요청이 너무 잦다며 잠시 막았습니다. 1~2분 뒤 다시 시도하세요. 이미 만든 이슈는 그대로 있습니다. ${raw}`;
  if (status === 401) return `토큰이 맞지 않습니다. 설정에서 토큰을 다시 붙여 넣거나 새로 만드세요. ${raw}`;
  const isPr = /\/pulls(\/|\?|$)/.test(path);
  if (status === 405 && /\/merge$/.test(path)) return `지금은 병합할 수 없는 상태입니다 (충돌, 초안, 검사 대기 등). GitHub 에서 PR 을 확인하세요. ${raw}`;
  if (status === 409 && /\/merge$/.test(path)) return `확인한 뒤에 PR 에 새 커밋이 올라왔습니다. 새로고침해서 바뀐 내용을 본 뒤 다시 병합하세요. ${raw}`;
  if (status === 422 && isPr && /own pull request/i.test(msg)) return `자기가 올린 PR 은 승인할 수 없습니다 (GitHub 규칙). 다른 사람이 승인해야 합니다. ${raw}`;
  if (status === 403 && method !== 'GET' && isPr) return `이 토큰으로는 PR 을 승인·병합할 수 없습니다. 토큰의 Pull requests 를 Read and write 로, 병합하려면 Contents 도 Read and write 로 바꾸세요 (발급 안내 5단계). ${raw}`;
  if ((status === 403 || status === 404) && isPr) return `이 토큰으로는 PR 을 읽을 수 없습니다. 토큰에 Pull requests 권한(Read and write)을 더하세요 (발급 안내 5단계). ${raw}`;
  if (status === 404 && /^\/repos\/[^/]+\/[^/]+(\/(issues|labels|contents)|$)/.test(path.split('?')[0])) return `저장소가 보이지 않습니다. 토큰에 저장소가 선택됐는지(주인), 초대를 수락했는지(협업자) 확인하세요. ${raw}`;
  if (status === 403 && method !== 'GET') return `이 토큰에는 쓰기 권한이 없습니다. 토큰의 Issues 권한을 Read and write 로 바꾸세요. ${raw}`;
  if (status === 403) return `이 토큰으로는 읽을 수 없습니다. 토큰 권한(Issues, Contents)을 확인하세요. ${raw}`;
  return `GitHub 요청이 실패했습니다 ${raw}`;
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// ── 이슈 해석 ───────────────────────────────────────────────────────
function parseIssue(it) {
  const names = (it.labels || []).map(l => typeof l === 'string' ? l : l.name);
  const pick = (prefix) => names.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
  const m = it.title.match(ID_RE);
  const status = pick('status:')[0] || (it.state === 'closed' ? '완료' : '백로그');
  return {
    number: it.number,
    title: it.title,
    shortTitle: m ? it.title.slice(m[0].length) : it.title,
    taskId: m ? m[1] : '',
    body: it.body || '',
    state: it.state,
    url: it.html_url,
    labels: names,
    status,
    phase: pick('phase-')[0] || '',
    agents: pick('agent-'),
    areas: pick('area-'),
    owner: pick('owner:')[0] || '',
    checker: pick('checker:')[0] || '',
    priority: names.find(n => PRIORITIES.includes(n)) || '',
    kinds: names.filter(n => BUG_KINDS.includes(n)),
    isPlan: names.includes(L.plan),
    flags: names.filter(n => FLAGS.includes(n)),
    comments: it.comments || 0,
    updated: it.updated_at,
    user: it.user?.login || '',
  };
}
const isBug = i => i.kinds.length > 0;
const tasks = () => S.issues.filter(i => !isBug(i));
const bugs = () => S.issues.filter(isBug);

// 상태·Owner 등 단일 값 라벨을 바꾼 라벨 배열을 만든다
function withSingle(labels, prefixOrList, value) {
  const drop = Array.isArray(prefixOrList) ? n => prefixOrList.includes(n) : n => n.startsWith(prefixOrList);
  const next = labels.filter(n => !drop(n));
  if (value) next.push(Array.isArray(prefixOrList) ? value : prefixOrList + value);
  return next;
}

// ── 데모 데이터 (토큰 없을 때) ──────────────────────────────────────
function demoIssues() {
  const mk = (n, title, labels, state = 'open', body = '') => ({ number: n, title, labels, state, body, html_url: '#', comments: 0, updated_at: '2026-10-04T00:00:00Z', user: { login: 'demo' } });
  // 예시 데이터: 실제 일감이 아니다 (공개 페이지에 기획 내용을 싣지 않는다)
  return [
    mk(1, '[EX-01] 예시 일감: 작업중', ['slime', 'phase-0b', 'status:작업중', 'checker:둘 다', 'P0']),
    mk(2, '[EX-02] 예시 일감: 설계 리뷰 대기', ['slime', 'phase-0b', 'agent-systems', 'status:설계리뷰', 'needs-design', 'owner:Dong', 'checker:Dong', 'P0']),
    mk(3, '[EX-03] 예시 일감: 승인 대기', ['slime', 'phase-0b', 'agent-systems', 'status:승인대기', 'owner:Dong', 'checker:Wan', 'P1']),
    mk(4, '[EX-04] 예시 일감: 백로그', ['slime', 'phase-0b', 'status:백로그', 'owner:Wan', 'checker:Wan', 'P2']),
    mk(5, '[EX-05] 예시 일감: 블록', ['slime', 'phase-0b', 'agent-pm', 'status:블록', 'owner:Dong', 'checker:Dong', 'P1']),
    mk(6, '[EX-06] 예시 일감: 완료', ['slime', 'phase-0b', 'agent-systems', 'status:완료'], 'closed'),
    mk(7, '예시 버그: 착지할 때 바닥을 뚫고 떨어짐', ['slime', 'bug', 'status:백로그', 'P0'], 'open', '## 재현 단계\n1. 높은 곳에서 점프\n2. 착지\n## 실제 결과\n바닥 아래로 떨어짐'),
    mk(8, '예시 버그: 팝업 문구 오탈자', ['slime', 'text', 'status:작업중', 'P2', 'agent-writer']),
    mk(9, '[기획] 예시 의견', ['slime', '기획', 'status:백로그']),
  ];
}

// ── PR 해석 ─────────────────────────────────────────────────────────
// slime-agent-run 이 올리는 PR: design/<ID> = 설계서 PR (본문 "설계서 대상: #이슈"), task/<ID> = 구현 PR ("Closes #이슈") (23-3, 26-4)
function parsePR(p) {
  const ref = p.head?.ref || '';
  const kind = /^design\//.test(ref) ? 'design' : /^task\//.test(ref) ? 'task' : 'other';
  const body = p.body || '';
  const link = body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|설계서 대상:)\s*#(\d+)/i) || body.match(/#(\d+)/);
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: p.merged_at ? 'merged' : p.state,
    draft: !!p.draft,
    ref,
    kind,
    issue: link ? Number(link[1]) : null,
    user: p.user?.login || '',
    updated: p.updated_at,
    sha: p.head?.sha || '',
    reviews: null, // 열린 PR 만 따로 불러온다
  };
}
// 사람마다 마지막 승인·변경 요청만 센다 (GitHub 이 보여 주는 방식과 같음)
function reviewSummary(reviews) {
  const last = {};
  (reviews || []).forEach(r => { if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) last[r.user?.login || '?'] = r.state; });
  const by = st => Object.keys(last).filter(u => last[u] === st);
  return { approved: by('APPROVED'), changes: by('CHANGES_REQUESTED') };
}
const PR_KIND = { design: '설계서', task: '구현', other: '기타' };
const PR_STATE = { open: '열림', merged: '병합됨', closed: '닫힘' };
const isSlimePR = pr => pr.kind !== 'other' || S.issues.some(i => i.number === pr.issue);

function demoPRs() {
  const mk = (n, title, ref, issue, reviews, state = 'open') => ({ ...parsePR({ number: 100 + n, title, html_url: '#', state, head: { ref, sha: 'demo' }, body: `${ref.startsWith('design/') ? '설계서 대상:' : 'Closes'} #${issue}`, user: { login: 'github-actions[bot]' }, updated_at: '2026-10-04T00:00:00Z' }), reviews });
  // 예시 데이터: 실제 PR 이 아니다
  return [
    mk(1, '[EX-02] 설계서: 예시 설계 리뷰 대기', 'design/EX-02', 2, []),
    mk(2, '[EX-03] 예시 구현 (승인됨)', 'task/EX-03', 3, [{ state: 'APPROVED', user: { login: 'wankyu9704' } }]),
  ];
}

// ── 데이터 불러오기 ─────────────────────────────────────────────────
async function loadIssues() {
  const c = cfg();
  if (!c.gh) { S.demo = true; S.issues = demoIssues().map(parseIssue); return; }
  S.demo = false;
  const raw = await ghAll(`/repos/${c.repo}/issues?labels=${encodeURIComponent(L.slime)}&state=all`);
  S.issues = raw.filter(i => !i.pull_request).map(parseIssue);
}

async function loadPRs() {
  const c = cfg();
  if (!c.gh) { S.prs = demoPRs(); return; }
  const raw = await gh(`/repos/${c.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
  S.prs = raw.map(parsePR);
  // 승인 수는 목록 API 에 없어서 열린 PR 만 따로 읽는다
  await Promise.all(S.prs.filter(p => p.state === 'open').map(async p => {
    try { p.reviews = await gh(`/repos/${c.repo}/pulls/${p.number}/reviews?per_page=100`); } catch { p.reviews = null; }
  }));
}

async function loadPlanVersions() {
  const c = cfg();
  let names = [];
  if (c.gh) {
    const list = await gh(`/repos/${c.repo}/contents/${encPath(PLAN_DIR)}?ref=${encodeURIComponent(c.branch)}`);
    names = list.map(f => f.name);
  } else {
    try { // 로컬 서버 디렉터리 목록에서 찾는다
      const html = await (await fetch('../기획/')).text();
      names = [...html.matchAll(/href="([^"]+)"/g)].map(m => decodeURIComponent(m[1]));
    } catch { /* file:// 등 */ }
  }
  const vers = [...new Set(names.map(n => (n.match(/^SlimeAdventure_Plan_(v[\d.]+)\.html$/) || [])[1]).filter(Boolean))];
  vers.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  S.planVersions = vers.length ? vers : ['v1.4'];
}

async function loadPlan(ver) {
  const c = cfg();
  const base = `SlimeAdventure_Plan_${ver}`;
  const frame = $('#plan-frame');
  $('#plan-gh').href = `https://github.com/${c.repo}/blob/${c.branch}/${encPath(PLAN_DIR)}/${encodeURIComponent(base)}.html`;
  if (c.gh) {
    const [html, src] = await Promise.all([
      gh(`/repos/${c.repo}/contents/${encPath(`${PLAN_DIR}/${base}.html`)}?ref=${encodeURIComponent(c.branch)}`, { raw: true }),
      gh(`/repos/${c.repo}/contents/${encPath(`${PLAN_DIR}/${base}.source.txt`)}?ref=${encodeURIComponent(c.branch)}`, { raw: true }).catch(() => ''),
    ]);
    frame.removeAttribute('src');
    frame.srcdoc = html;
    S.planSource = src;
  } else {
    // 토큰이 없으면 같은 체크아웃의 기획/ 폴더에서 읽는다. 링크로 연 페이지에는 그 폴더가 없다
    let ok = false;
    try { const r = await fetch(`../기획/${base}.source.txt`); ok = r.ok; S.planSource = ok ? await r.text() : ''; } catch { S.planSource = ''; }
    if (ok) { frame.removeAttribute('srcdoc'); frame.src = `../기획/${base}.html`; }
    else { frame.removeAttribute('src'); frame.srcdoc = '<p style="font:14px system-ui;padding:24px">설정에서 GitHub 토큰을 넣으면 기획서가 여기에 보입니다.</p>'; }
  }
  S.planVersion = ver;
  S.planTasks = parsePlanTasks(S.planSource);
  renderPlanSide();
}

// 34장 일감 표를 읽는다: | ID | 일감 | AI | 전 → 후 | AI 시간 | 체크 |
function parsePlanTasks(src) {
  const out = [];
  const start = src.search(/^## 34\./m);
  if (start < 0) return out;
  const rest = src.slice(start);
  const end = rest.search(/^## 35\./m);
  let phase = '';
  for (const line of (end > 0 ? rest.slice(0, end) : rest).split('\n')) {
    const ph = line.match(/^### Phase (\w+)/);
    if (ph) { phase = ph[1]; continue; }
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length >= 6 && /^[A-Z]{1,3}-\d{2}$/.test(cells[0])) {
      out.push({ id: cells[0], name: cells[1], ai: cells[2], change: cells[3], hours: cells[4], check: cells[5], phase });
    }
  }
  return out;
}
function planChapters(src) {
  return [...src.matchAll(/^## (\d+)\. (.+)$/gm)].map(m => `${m[1]}. ${m[2].trim()}`);
}

// ── 렌더: 공통 ──────────────────────────────────────────────────────
function pills(i) {
  const p = [];
  if (i.priority) p.push(`<span class="pill r">${esc(i.priority)}</span>`);
  if (i.phase) p.push(`<span class="pill b">Phase ${esc(i.phase)}</span>`);
  i.agents.forEach(a => p.push(`<span class="pill">${esc(a)}</span>`));
  if (i.owner) p.push(`<span class="pill c">Owner ${esc(i.owner)}</span>`);
  if (i.checker) p.push(`<span class="pill a">체크 ${esc(i.checker)}</span>`);
  i.kinds.forEach(k => p.push(`<span class="pill r">${esc(k)}</span>`));
  if (i.isPlan) p.push('<span class="pill a">기획</span>');
  i.flags.forEach(f => p.push(`<span class="pill">${esc(f)}</span>`));
  return p.join('');
}

function renderHeader() {
  const c = cfg();
  $('#who').textContent = c.me ? `나: ${c.me}` : '';
  $('#conn').textContent = S.demo ? '데모 모드' : c.repo;
  $('#demo-notice').classList.toggle('hide', !S.demo);
  $('#inbox-prompt').textContent = inboxPrompt();
}

// 25-3 뷰 정의
const VIEWS = {
  all: { name: '전체 칸반', f: () => true },
  wan: { name: 'Wan 할 일', f: i => (i.status === '승인대기' && ['Wan', '둘 다'].includes(i.checker)) || i.owner === 'Wan' },
  dongDesign: { name: 'Dong 설계 대기', f: i => i.status === '설계리뷰' || i.status === '블록' },
  dong: { name: 'Dong 할 일', f: i => i.status === '승인대기' && ['Dong', '둘 다'].includes(i.checker) },
};

// ── 렌더: 대시보드 ──────────────────────────────────────────────────
function renderDash() {
  const t = tasks(), b = bugs();
  const open = t.filter(i => i.state === 'open');
  const count = s => open.filter(i => i.status === s).length;
  const st = s => [s, count(s), `board:status=${encodeURIComponent(s)}`];
  const stats = [
    ['열린 일감', open.length, 'board:'], st('작업중'), st('승인대기'), st('설계리뷰'), st('블록'),
    ['열린 버그', b.filter(i => i.state === 'open').length, 'bts:state=open'],
    ['열린 PR', S.prs.filter(p => p.state === 'open' && isSlimePR(p)).length, 'prs:'],
  ];
  $('#dash-stats').innerHTML = stats.map(([k, v, nav]) => `<div class="card link" data-nav="${esc(nav)}" title="${esc(k)} 일감 보기"><div class="muted small">${esc(k)}</div><div class="stat">${v}</div></div>`).join('');

  const me = cfg().me;
  const lists = [];
  const listCard = (title, items, nav) => `<div class="card"><h3 style="margin-top:0" class="dash-h" data-nav="${esc(nav)}" title="일감 탭에서 보기">${esc(title)} <span class="muted small">${items.length} →</span></h3>${items.length ? items.slice(0, 8).map(i => `<div class="tcard" data-issue="${i.number}"><span class="id">${esc(i.taskId || '#' + i.number)}</span> ${esc(i.shortTitle)}<div>${pills(i)}</div></div>`).join('') : '<p class="muted small">없음</p>'}</div>`;
  if (me === 'Wan' || !me) lists.push(listCard('Wan 할 일', open.filter(VIEWS.wan.f), 'board:view=wan'));
  if (me === 'Dong' || !me) { lists.push(listCard('Dong 설계 대기', open.filter(VIEWS.dongDesign.f), 'board:view=dongDesign')); lists.push(listCard('Dong 할 일', open.filter(VIEWS.dong.f), 'board:view=dong')); }
  lists.push(listCard('P0 버그', b.filter(i => i.state === 'open' && i.priority === 'P0'), 'bts:state=open&pri=P0'));
  renderMatrix(t);
  $('#dash-lists').innerHTML = lists.join('');

  const byId = issueByTaskId();
  const rows = PHASES.map(p => {
    const pt = S.planTasks.filter(x => x.phase === p);
    if (!pt.length) return '';
    const linked = pt.filter(x => byId[x.id]);
    const done = pt.filter(x => byId[x.id] && (byId[x.id].state === 'closed' || byId[x.id].status === '완료'));
    const pct = Math.round(done.length / pt.length * 100);
    return `<tr><td>Phase ${esc(p)}</td><td>${pt.length}</td><td>${linked.length}</td><td>${done.length}</td><td style="white-space:nowrap"><div style="display:inline-block;vertical-align:middle;background:var(--soft);border-radius:4px;height:8px;width:160px"><div style="background:var(--a);height:8px;border-radius:4px;width:${pct * 1.6}px"></div></div> ${pct}%</td></tr>`;
  }).join('');
  $('#dash-phase').innerHTML = `<tr><th>단계</th><th>기획 일감</th><th>이슈 있음</th><th>완료</th><th>진행</th></tr>${rows || '<tr><td colspan="5" class="muted">기획서를 아직 불러오지 못했습니다</td></tr>'}`;
}
// 단계 × 상태 표. 닫힌 이슈는 완료로 센다
function renderMatrix(t) {
  const stOf = i => (i.state === 'closed' ? '완료' : i.status);
  const phases = [...PHASES.filter(p => t.some(i => i.phase === p)), ...(t.some(i => !i.phase) ? ['-'] : [])];
  const cell = (n, nav) => n ? `<td class="n"><a href="#" data-nav="${esc(nav)}">${n}</a></td>` : '<td class="n zero">0</td>';
  const row = (label, items, ph) => {
    const done = items.filter(i => stOf(i) === '완료').length;
    const pct = items.length ? Math.round(done / items.length * 100) : 0;
    const base = ph ? `phase=${encodeURIComponent(ph)}&` : '';
    return `<tr><td>${esc(label)}</td>${STATUSES.map(s => cell(items.filter(i => stOf(i) === s).length, `board:${base}status=${encodeURIComponent(s)}${s === '완료' ? '&closed=1' : ''}`)).join('')}`
      + `${cell(items.length, `board:${base}closed=1`)}<td class="n">${pct}%</td></tr>`;
  };
  const body = phases.map(p => row(p === '-' ? 'Phase 없음' : `Phase ${p}`, t.filter(i => (i.phase || '-') === p), p)).join('');
  $('#dash-matrix').innerHTML = `<tr><th>단계</th>${STATUSES.map(s => `<th class="n">${esc(s)}</th>`).join('')}<th class="n">합계</th><th class="n">완료율</th></tr>`
    + (body ? body + row('전체', t, '').replace('<td>전체</td>', '<td><b>전체</b></td>') : `<tr><td colspan="${STATUSES.length + 3}" class="muted">일감이 없습니다</td></tr>`);
}

// 칸반 높이를 남은 화면 높이에 맞춘다 (가로 스크롤바가 화면 아래쪽 안에 보이도록)
function fitBoard() {
  const b = $('#board');
  if (!b.offsetParent) return;
  const top = b.getBoundingClientRect().top + window.scrollY;
  b.style.height = `${Math.max(320, window.innerHeight - top - 16)}px`;
}
window.addEventListener('resize', fitBoard);

// 대시보드에서 누른 곳으로 이동: "board:status=작업중", "bts:state=open&pri=P0"
function navTo(spec) {
  const [view, qs = ''] = spec.split(':');
  const p = new URLSearchParams(qs);
  if (view === 'board') {
    ['#bf-phase', '#bf-agent', '#bf-owner', '#bf-status', '#bf-q'].forEach(s => { $(s).value = ''; });
    $('#bf-view').value = p.get('view') || 'all';
    if (p.get('phase')) $('#bf-phase').value = p.get('phase');
    if (p.get('status')) $('#bf-status').value = p.get('status');
    $('#bf-closed').checked = p.get('closed') === '1';
    renderBoard();
  } else if (view === 'bts') {
    ['#bt-kind', '#bt-status', '#bt-pri', '#bt-q'].forEach(s => { $(s).value = ''; });
    $('#bt-state').value = p.get('state') || 'open';
    if (p.get('pri')) $('#bt-pri').value = p.get('pri');
    renderBts();
  } else if (view === 'prs') {
    $('#pr-state').value = 'open';
    renderPRs();
  }
  switchView(view);
  window.scrollTo(0, 0);
}
function issueByTaskId() {
  const m = {};
  // 리비전 이슈([SL-06-R1])는 원본 ID 진행에 넣지 않는다
  S.issues.forEach(i => { if (i.taskId && !/-R\d+$/.test(i.taskId)) m[i.taskId] = i; });
  return m;
}

// ── 렌더: 기획서 사이드 ─────────────────────────────────────────────
function renderPlanSide() {
  $('#fb-chapter').innerHTML = opt('', '(장 선택)') + planChapters(S.planSource).map(ch => opt(ch)).join('');
  const phases = [...new Set(S.planTasks.map(t => t.phase))];
  const cur = $('#pt-phase').value || phases[0] || '';
  $('#pt-phase').innerHTML = phases.map(p => opt(p, `Phase ${p}`, p === cur)).join('');
  renderPlanTasks();
}
function renderPlanTasks() {
  const ph = $('#pt-phase').value;
  const byId = issueByTaskId();
  const rows = S.planTasks.filter(t => t.phase === ph).map(t => {
    const i = byId[t.id];
    const state = i ? `<a href="#" data-issue="${i.number}">#${i.number} ${esc(i.status)}</a>` : '<span class="muted">이슈 없음</span>';
    return `<tr><td>${i ? '' : `<input type="checkbox" class="pt-chk" value="${esc(t.id)}">`}</td><td><b>${esc(t.id)}</b> ${esc(t.name)}<div class="small muted">${esc(t.ai)} · ${esc(t.hours)} · 체크 ${esc(t.check)}</div></td><td class="small" style="white-space:nowrap">${state}</td></tr>`;
  }).join('');
  $('#pt-list').innerHTML = `<div class="tablewrap"><table>${rows || '<tr><td class="muted">일감 표를 찾지 못했습니다</td></tr>'}</table></div>`;
  updatePtButton();
}
function updatePtButton() {
  const n = document.querySelectorAll('.pt-chk:checked').length;
  $('#pt-create').disabled = n === 0;
  $('#pt-create').textContent = n ? `선택한 일감 ${n}개 이슈 만들기` : '선택한 일감 이슈 만들기';
}

// 기획서 표의 "체크" 칸(W = Wan, P = Dong, 34장 범례)에서 Checker 를 읽는다
function checkerFromPlan(check) {
  const w = /\bW\b/.test(check), p = /\bP\b/.test(check);
  return w && p ? '둘 다' : w ? 'Wan' : p ? 'Dong' : '';
}
function taskBody({ purpose = '', before = '', after = '', id = '', extra = '' } = {}) {
  return [
    '## 목적 / 관련 GDD 장', purpose, '',
    '## 전 (현재 상태)', before, '',
    '## 후 (기대 결과)', after, '',
    '## 설계 필요 여부 (needs-design 판정과 사유) / Core 재사용 확인', '', '',
    '## 입력·출력 파일 경로', '', '',
    '## 수용 기준', '- [ ] ', '',
    '## 테스트 씬', id ? `Scenes/Test/${id}` : '', '',
    '## 성능 예산', '', '',
    '## Checker 체크리스트', '- [ ] ', '',
    '## 선행 이슈 / 금지 사항', '', '',
    '## 레퍼런스', '', extra,
  ].join('\n');
}
function planTaskToIssue(t) {
  const [before, after] = t.change.split('→').map(s => s.trim());
  const labels = [L.slime, L.status('백로그')];
  if (PHASES.includes(t.phase)) labels.push(L.phase(t.phase));
  AGENTS.filter(a => new RegExp(`\\b${a}\\b`).test(t.ai)).forEach(a => labels.push(L.agent(a)));
  const ch = checkerFromPlan(t.check);
  if (ch) labels.push(L.checker(ch));
  const extra = `\n---\n기획서 ${S.planVersion || ''} 34장에서 생성 · 담당 AI: ${t.ai} · AI 시간: ${t.hours} · 체크: ${t.check}`;
  return { title: `[${t.id}] ${t.name}`, body: taskBody({ purpose: t.name, before, after, id: t.id, extra }), labels };
}

// ── 렌더: 칸반 ──────────────────────────────────────────────────────
function boardFilters() {
  const keep = (sel, html) => { const v = $(sel).value; $(sel).innerHTML = html; if (v) $(sel).value = v; };
  keep('#bf-view', Object.entries(VIEWS).map(([k, v]) => opt(k, v.name)).join(''));
  keep('#bf-phase', opt('', '모든 Phase') + PHASES.map(p => opt(p, `Phase ${p}`)).join('') + opt('-', 'Phase 없음'));
  keep('#bf-status', opt('', '모든 상태') + STATUSES.map(s => opt(s)).join(''));
  keep('#bf-agent', opt('', '모든 AI') + AGENTS.map(a => opt(a)).join(''));
  keep('#bf-owner', opt('', '모든 Owner') + PEOPLE.map(p => opt(p)).join(''));
}
function renderBoard() {
  const v = VIEWS[$('#bf-view').value] || VIEWS.all;
  const ph = $('#bf-phase').value, ag = $('#bf-agent').value, ow = $('#bf-owner').value, q = $('#bf-q').value.trim().toLowerCase();
  const fs = $('#bf-status').value, asTable = $('#bf-mode').value === 'table';
  const withClosed = $('#bf-closed').checked;
  const stOf = i => (i.state === 'closed' ? '완료' : i.status);
  const list = tasks().filter(i => (withClosed || i.state === 'open') && v.f(i)
    && (!ph || (ph === '-' ? !i.phase : i.phase === ph)) && (!ag || i.agents.includes(ag)) && (!ow || i.owner === ow)
    && (!fs || stOf(i) === fs) && (!q || i.title.toLowerCase().includes(q)));
  $('#board').classList.toggle('hide', asTable);
  $('#board-table-wrap').classList.toggle('hide', !asTable);
  if (asTable) {
    const ord = i => [PHASES.indexOf(i.phase) < 0 ? 99 : PHASES.indexOf(i.phase), STATUSES.indexOf(stOf(i))];
    const sorted = [...list].sort((a, b) => { const x = ord(a), y = ord(b); return x[0] - y[0] || x[1] - y[1] || (a.taskId || '').localeCompare(b.taskId || '', undefined, { numeric: true }); });
    $('#board-table').innerHTML = '<tr><th>ID</th><th>제목</th><th>Phase</th><th>상태</th><th>AI</th><th>Owner</th><th>체크</th><th>우선</th><th>갱신</th></tr>'
      + (sorted.map(i => `<tr class="click" data-issue="${i.number}"><td><b>${esc(i.taskId || '#' + i.number)}</b></td><td>${esc(i.shortTitle)}</td><td>${esc(i.phase)}</td><td>${esc(stOf(i))}</td><td>${esc(i.agents.join(', '))}</td><td>${esc(i.owner)}</td><td>${esc(i.checker)}</td><td>${esc(i.priority)}</td><td class="small muted">${esc((i.updated || '').slice(0, 10))}</td></tr>`).join('')
        || '<tr><td colspan="9" class="muted">해당하는 일감이 없습니다</td></tr>');
    return;
  }
  $('#board').classList.toggle('single', !!fs);
  $('#board').innerHTML = STATUSES.filter(s => !fs || s === fs).map(s => {
    const items = list.filter(i => stOf(i) === s);
    return `<div class="col" data-status="${esc(s)}"><h4><span>${esc(s)}</span><span class="muted">${items.length}</span></h4>${items.map(i => `<div class="tcard" draggable="true" data-issue="${i.number}"><div class="id">${esc(i.taskId || '#' + i.number)}</div>${esc(i.shortTitle)}<div>${pills(i)}</div></div>`).join('')}</div>`;
  }).join('');
}

// ── 렌더: 버그 ──────────────────────────────────────────────────────
function btsFilters() {
  const keep = (sel, html) => { const v = $(sel).value; $(sel).innerHTML = html; if (v) $(sel).value = v; };
  keep('#bt-kind', opt('', '모든 종류') + BUG_KINDS.map(k => opt(k)).join(''));
  keep('#bt-status', opt('', '모든 상태') + STATUSES.map(s => opt(s)).join(''));
  keep('#bt-pri', opt('', '모든 우선순위') + PRIORITIES.map(p => opt(p)).join(''));
}
function renderBts() {
  const k = $('#bt-kind').value, st = $('#bt-status').value, pr = $('#bt-pri').value, state = $('#bt-state').value, q = $('#bt-q').value.trim().toLowerCase();
  const list = bugs().filter(i => (!k || i.kinds.includes(k)) && (!st || i.status === st) && (!pr || i.priority === pr)
    && (state === 'all' || i.state === state) && (!q || i.title.toLowerCase().includes(q)))
    .sort((a, b) => (a.priority || 'P9').localeCompare(b.priority || 'P9') || b.number - a.number);
  $('#bt-table').innerHTML = `<tr><th>#</th><th>제목</th><th>종류</th><th>우선</th><th>상태</th><th>담당 AI</th><th>갱신</th></tr>` +
    (list.map(i => `<tr class="click" data-issue="${i.number}"><td>${i.number}</td><td>${esc(i.title)}</td><td>${i.kinds.map(x => `<span class="pill r">${esc(x)}</span>`).join('')}</td><td>${esc(i.priority)}</td><td>${esc(i.state === 'closed' ? '닫힘' : i.status)}</td><td>${esc(i.agents.join(', '))}</td><td class="small muted">${esc((i.updated || '').slice(0, 10))}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">해당하는 버그가 없습니다</td></tr>');
}

// ── 렌더: PR ────────────────────────────────────────────────────────
function prReviewCell(pr) {
  if (pr.state !== 'open') return '';
  if (!pr.reviews) return '<span class="muted">-</span>';
  const r = reviewSummary(pr.reviews);
  const out = [];
  if (r.approved.length) out.push(`<span class="pill a">승인 ${r.approved.length}</span>`);
  if (r.changes.length) out.push(`<span class="pill r">변경 요청 ${r.changes.length}</span>`);
  return out.join('') || '<span class="pill c">리뷰 대기</span>';
}
function renderPRs() {
  const st = $('#pr-state').value, all = $('#pr-all').checked;
  const list = S.prs.filter(p => (st === 'all' || p.state === st) && (all || isSlimePR(p)));
  $('#pr-table').innerHTML = '<tr><th>#</th><th>제목</th><th>종류</th><th>일감</th><th>리뷰</th><th>상태</th><th>갱신</th></tr>'
    + (list.map(p => {
      const iss = S.issues.find(i => i.number === p.issue);
      return `<tr class="click" data-pr="${p.number}"><td>${p.number}</td><td>${esc(p.title)}${p.draft ? ' <span class="pill">초안</span>' : ''}</td><td>${esc(PR_KIND[p.kind])}</td>`
        + `<td class="small">${p.issue ? `#${p.issue}${iss ? ` ${esc(iss.status)}` : ''}` : ''}</td><td>${prReviewCell(p)}</td><td>${esc(PR_STATE[p.state])}</td><td class="small muted">${esc((p.updated || '').slice(0, 10))}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">해당하는 PR 이 없습니다</td></tr>');
}

function renderAll() {
  renderHeader(); renderDash(); boardFilters(); renderBoard(); btsFilters(); renderBts(); renderPRs(); renderPlanTasks();
}

// ── 쓰기 ────────────────────────────────────────────────────────────
function demoGuard() {
  if (S.demo) { toast('데모 모드에서는 GitHub 에 저장하지 않습니다. 설정에서 토큰을 넣으세요.'); return true; }
  return false;
}
async function setLabels(issue, labels) {
  if (S.demo) { issue.labels = labels; Object.assign(issue, parseIssue({ ...rawOf(issue), labels })); renderAll(); return; }
  const c = cfg();
  const it = await gh(`/repos/${c.repo}/issues/${issue.number}`, { method: 'PATCH', body: { labels } });
  replaceIssue(it);
}
function rawOf(i) { return { number: i.number, title: i.title, labels: i.labels, state: i.state, body: i.body, html_url: i.url, comments: i.comments, updated_at: i.updated, user: { login: i.user } }; }
function replaceIssue(it) {
  const p = parseIssue(it);
  const idx = S.issues.findIndex(x => x.number === p.number);
  if (idx >= 0) S.issues[idx] = p; else S.issues.unshift(p);
  renderAll();
  return p;
}
async function createIssue({ title, body, labels }) {
  const c = cfg();
  const it = await gh(`/repos/${c.repo}/issues`, { method: 'POST', body: { title, body, labels } });
  return replaceIssue(it);
}

// ── 상세 드로어 ─────────────────────────────────────────────────────
function openDrawer(titleHtml, bodyHtml) {
  S.currentPR = null;
  $('#dr-title').innerHTML = titleHtml; $('#dr-body').innerHTML = bodyHtml; $('#drawer').classList.add('on');
}
function closeDrawer() { $('#drawer').classList.remove('on'); S.current = null; S.currentPR = null; }

function agentPrompt(i) {
  return `pm, GitHub 이슈 #${i.number} ${i.title} 를 gh 로 읽고 기획서 20장 라이프사이클대로 처리해. 설계가 필요하면 설계서 PR 까지만 하고 Dong 승인을 기다려.`;
}
function inboxPrompt() { return `pm, 받은 일감 확인 (gh issue list --label slime 에서 내 Owner 일감 중 상태가 스펙완료·설계승인·수정요청인 것)`; }

// 본문 체크박스 (GitHub 작업 목록 "- [ ]" / "- [x]"). 누르면 그 줄만 바꿔 이슈 본문에 저장한다.
const TASK_LINE = /^(\s*[-*+] \[)([ xX])(\] )/;
function bodyHtml(body) {
  return (body || '').split('\n').map((line, n) => {
    const m = line.match(TASK_LINE);
    if (!m) return esc(line);
    const on = m[2] !== ' ';
    return `${esc(m[1].slice(0, -1))}<input type="checkbox" class="body-chk" data-line="${n}"${on ? ' checked' : ''}>${esc(line.slice(m[0].length - 1))}`;
  }).join('\n');
}
async function toggleBodyCheck(issue, n, on) {
  const flip = body => {
    const lines = (body || '').split('\n');
    if (!TASK_LINE.test(lines[n] || '')) return null;
    lines[n] = lines[n].replace(TASK_LINE, `$1${on ? 'x' : ' '}$3`);
    return lines.join('\n');
  };
  if (S.demo) { issue.body = flip(issue.body) ?? issue.body; return; }
  // 다른 사람이 그사이 본문을 고쳤을 수 있으니 최신 본문에서 같은 줄을 바꾼다.
  const c = cfg();
  const fresh = await gh(`/repos/${c.repo}/issues/${issue.number}`);
  const prev = (issue.body || '').split('\n')[n];
  const body = (fresh.body || '').split('\n')[n] === prev ? flip(fresh.body) : null;
  if (body === null) { replaceIssue(fresh); showIssue(issue.number); throw new Error('본문이 그사이 바뀌었습니다. 다시 불러왔으니 한 번 더 눌러 주세요.'); }
  replaceIssue(await gh(`/repos/${c.repo}/issues/${issue.number}`, { method: 'PATCH', body: { body } }));
  S.current = S.issues.find(x => x.number === issue.number);
}

async function showIssue(n) {
  const i = S.issues.find(x => x.number === Number(n));
  if (!i) return;
  S.current = i;
  const sel = (id, list, cur, empty) => `<select id="${id}">${opt('', empty, !cur)}${list.map(v => opt(v, v, v === cur)).join('')}</select>`;
  openDrawer(
    `<div class="small muted"><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number}</a> · ${esc(i.state === 'closed' ? '닫힘' : '열림')}</div><b>${esc(i.title)}</b><div>${pills(i)}</div>`,
    `<div class="row">
      <span>상태 ${sel('d-status', STATUSES, i.status, '-')}</span>
      <span>우선 ${sel('d-pri', PRIORITIES, i.priority, '-')}</span>
      <span>Owner ${sel('d-owner', PEOPLE, i.owner, '-')}</span>
      <span>Checker ${sel('d-checker', CHECKERS, i.checker, '-')}</span>
      <span>Phase ${sel('d-phase', PHASES, i.phase, '-')}</span>
    </div>
    <div class="row small" style="margin-top:6px">${FLAGS.map(f => `<label><input type="checkbox" class="d-flag" value="${esc(f)}"${i.flags.includes(f) ? ' checked' : ''}> ${esc(f)}</label>`).join('')}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn pri" id="d-save">라벨 저장</button>
      <button class="btn" id="d-run" title="agent-run 라벨: Owner PC 러너가 처리 (26장)">Claude에게 맡기기</button>
      <button class="btn" id="d-prompt">Claude Code 지시문 복사</button>
      <button class="btn ${i.state === 'open' ? 'warn' : ''}" id="d-close">${i.state === 'open' ? '이슈 닫기' : '다시 열기'}</button>
    </div>
    <h3>본문</h3><div class="body-md">${bodyHtml(i.body) || '<span class="muted">(비어 있음)</span>'}</div>
    <h3>댓글</h3><div id="d-comments" class="small muted">${S.demo ? '데모 모드' : '불러오는 중…'}</div>
    <textarea id="d-cmt" placeholder="댓글. 수정 요청은 /수정 으로 시작 (23-2)"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn pri" id="d-cmt-send">댓글 달기</button><button class="btn" id="d-revise">/수정 양식 넣기</button></div>`);
  if (!S.demo) {
    try {
      const cs = await gh(`/repos/${cfg().repo}/issues/${i.number}/comments?per_page=100`);
      if (S.current !== i) return;
      $('#d-comments').innerHTML = cs.length ? cs.map(c => `<div class="comment"><b>${esc(c.user?.login)}</b> <span class="muted">${esc(c.created_at.slice(0, 16).replace('T', ' '))}</span><div style="white-space:pre-wrap;color:var(--ink)">${esc(c.body)}</div></div>`).join('') : '없음';
    } catch (e) { $('#d-comments').textContent = e.message; }
  }
}

// PR 상세: 바뀐 파일·리뷰·댓글을 보고 승인·변경 요청·병합한다.
// 병합 조건 (18-2, 20장): 사람 1명 이상 승인 + 변경 요청 없음 + 초안 아님 + 충돌 없음. 브랜치 보호를 못 써서 이 페이지가 지킨다.
async function showPR(n) {
  const pr = S.prs.find(x => x.number === Number(n));
  if (!pr) return;
  S.current = null;
  const iss = S.issues.find(i => i.number === pr.issue);
  const me = cfg().me;
  openDrawer(
    `<div class="small muted"><a href="${esc(pr.url)}" target="_blank" rel="noopener">PR #${pr.number}</a> · ${esc(PR_STATE[pr.state])} · ${esc(PR_KIND[pr.kind])} · <code>${esc(pr.ref)}</code></div><b>${esc(pr.title)}</b>`
      + `<div class="small">${pr.issue ? `일감 <a href="${esc(iss ? iss.url : '#')}" target="_blank" rel="noopener">#${pr.issue}</a> ${iss ? esc(iss.shortTitle) + ' · ' + esc(iss.status) : ''}` : '연결된 일감 없음'}</div>`,
    `<div class="row"><a class="btn" href="${esc(pr.url)}/files" target="_blank" rel="noopener" style="text-decoration:none">GitHub 에서 바뀐 내용 보기</a></div>
    <h3>병합</h3><div id="p-merge" class="small muted">${S.demo ? '데모 모드' : '확인하는 중…'}</div>
    ${pr.state === 'open' ? `<h3>리뷰</h3>
    <textarea id="p-cmt" placeholder="리뷰 의견 (변경 요청은 필수, 승인은 선택)"></textarea>
    <div class="row" style="margin-top:6px"><button class="btn pri" id="p-approve">승인</button><button class="btn warn" id="p-changes">변경 요청</button><button class="btn" id="p-comment">댓글만</button></div>` : ''}
    <h3>바뀐 파일</h3><div id="p-files" class="small muted">${S.demo ? '데모 모드' : '불러오는 중…'}</div>
    <h3>리뷰 기록 · 댓글</h3><div id="p-talk" class="small muted">${S.demo ? '데모 모드' : '불러오는 중…'}</div>`);
  S.currentPR = pr;
  if (S.demo) { renderMergeBox(pr, { mergeable: true }); return; }
  const c = cfg();
  try {
    const [detail, files, reviews, comments] = await Promise.all([
      gh(`/repos/${c.repo}/pulls/${pr.number}`),
      gh(`/repos/${c.repo}/pulls/${pr.number}/files?per_page=100`),
      gh(`/repos/${c.repo}/pulls/${pr.number}/reviews?per_page=100`),
      gh(`/repos/${c.repo}/issues/${pr.number}/comments?per_page=100`),
    ]);
    if (S.currentPR !== pr) return;
    Object.assign(pr, parsePR(detail), { reviews });
    $('#p-files').innerHTML = files.length ? `<div class="tablewrap"><table>${files.map(f => `<tr><td>${esc(f.filename)}</td><td class="n" style="white-space:nowrap"><span style="color:var(--a)">+${f.additions}</span> <span style="color:var(--r)">-${f.deletions}</span></td></tr>`).join('')}</table></div>` : '없음';
    const talk = [
      ...reviews.filter(r => r.state !== 'PENDING').map(r => ({ at: r.submitted_at || '', who: r.user?.login, tag: { APPROVED: '승인', CHANGES_REQUESTED: '변경 요청', COMMENTED: '리뷰 의견', DISMISSED: '취소됨' }[r.state] || r.state, body: r.body })),
      ...comments.map(x => ({ at: x.created_at, who: x.user?.login, tag: '', body: x.body })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    $('#p-talk').innerHTML = talk.length ? talk.map(t => `<div class="comment"><b>${esc(t.who)}</b> ${t.tag ? `<span class="pill ${t.tag === '승인' ? 'a' : t.tag === '변경 요청' ? 'r' : ''}">${esc(t.tag)}</span>` : ''} <span class="muted">${esc(t.at.slice(0, 16).replace('T', ' '))}</span>${t.body ? `<div style="white-space:pre-wrap;color:var(--ink)">${esc(t.body)}</div>` : ''}</div>`).join('') : '없음';
    renderMergeBox(pr, detail, me);
    renderPRs();
  } catch (e) { $('#p-merge').textContent = e.message; }
}
function mergeBlockers(pr, detail) {
  const r = reviewSummary(pr.reviews);
  const why = [];
  if (pr.draft) why.push('초안 PR 입니다');
  if (!r.approved.length) why.push('사람 1명 이상의 승인이 필요합니다 (18-2)');
  if (r.changes.length) why.push(`변경 요청이 남아 있습니다: ${r.changes.join(', ')}`);
  if (detail.mergeable === false) why.push('main 과 충돌합니다. 충돌을 먼저 풀어야 합니다');
  if (detail.mergeable == null && pr.state === 'open') why.push('GitHub 이 병합 가능 여부를 계산 중입니다. 잠시 뒤 다시 여세요');
  return { why, r };
}
function renderMergeBox(pr, detail, me = cfg().me) {
  if (pr.state !== 'open') { $('#p-merge').textContent = `${PR_STATE[pr.state]} PR 입니다.`; return; }
  const { why, r } = mergeBlockers(pr, detail);
  const design = pr.kind === 'design' && pr.issue;
  const designOpt = design ? `<label class="small" style="display:block;margin-top:6px"><input type="checkbox" id="p-approve-design"${me === 'Dong' ? ' checked' : ' disabled'}> 병합한 뒤 일감 #${pr.issue} 에 <code>design-approved</code> 라벨 붙이기 (구현 자동 시작, 21-4)${me === 'Dong' ? '' : ' · 설계 승인 라벨은 Dong 만 붙입니다'}</label>` : '';
  const doneOpt = pr.kind === 'task' && pr.issue ? `<div class="small muted" style="margin-top:4px">병합하면 일감 #${pr.issue} 은 닫히고 상태가 완료로 바뀝니다.</div>` : '';
  $('#p-merge').innerHTML = (r.approved.length ? `<div>승인: ${r.approved.map(esc).join(', ')}</div>` : '')
    + (why.length ? `<ul style="margin:4px 0">${why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '<div style="color:var(--a)">병합할 수 있습니다.</div>')
    + designOpt + doneOpt
    + `<div class="row" style="margin-top:6px"><button class="btn pri" id="p-merge-btn"${why.length ? ' disabled' : ''}>main 에 병합</button></div>`;
}
async function reviewPR(event) {
  const pr = S.currentPR;
  const body = $('#p-cmt').value.trim();
  if (event === 'REQUEST_CHANGES' && !body) { toast('변경 요청은 이유를 적어야 합니다'); return; }
  if (event === 'COMMENT' && !body) { toast('의견을 적어 주세요'); return; }
  if (demoGuard()) return;
  await gh(`/repos/${cfg().repo}/pulls/${pr.number}/reviews`, { method: 'POST', body: { event, body, commit_id: pr.sha || undefined } });
  toast({ APPROVE: '승인했습니다', REQUEST_CHANGES: '변경 요청을 남겼습니다', COMMENT: '의견을 남겼습니다' }[event]);
  showPR(pr.number);
}
async function mergePR() {
  const pr = S.currentPR;
  if (demoGuard()) return;
  const withLabel = $('#p-approve-design')?.checked;
  const msg = `PR #${pr.number} 을 main 에 병합합니다.${withLabel ? `\n병합 뒤 #${pr.issue} 에 design-approved 를 붙여 구현을 시작합니다.` : ''}\n되돌리려면 GitHub 에서 Revert 해야 합니다. 계속할까요?`;
  if (!confirm(msg)) return;
  const c = cfg();
  // sha 를 같이 보내 확인한 뒤에 올라온 커밋은 병합하지 않는다 (409)
  await gh(`/repos/${c.repo}/pulls/${pr.number}/merge`, { method: 'PUT', body: { merge_method: 'merge', sha: pr.sha } });
  const iss = S.issues.find(i => i.number === pr.issue);
  if (iss && withLabel && !iss.labels.includes('design-approved')) await setLabels(iss, [...iss.labels, 'design-approved']);
  if (iss && pr.kind === 'task') await setLabels(iss, withSingle(iss.labels, 'status:', '완료'));
  toast(`PR #${pr.number} 을 병합했습니다`, 4000);
  await loadPRs().catch(() => {});
  renderAll();
  showPR(pr.number);
}

async function saveDrawerLabels() {
  const i = S.current;
  let labels = [...i.labels];
  labels = withSingle(labels, 'status:', $('#d-status').value);
  labels = withSingle(labels, PRIORITIES, $('#d-pri').value);
  labels = withSingle(labels, 'owner:', $('#d-owner').value);
  labels = withSingle(labels, 'checker:', $('#d-checker').value);
  labels = withSingle(labels, 'phase-', $('#d-phase').value);
  const flags = [...document.querySelectorAll('.d-flag:checked')].map(x => x.value);
  labels = labels.filter(n => !FLAGS.includes(n)).concat(flags);
  await setLabels(i, labels);
  toast('저장했습니다');
  showIssue(i.number);
}

function newTaskForm(prefill = {}) {
  const sel = (id, list, empty, cur = '') => `<select id="${id}">${opt('', empty)}${list.map(v => opt(v, v, v === cur)).join('')}</select>`;
  openDrawer('<b>새 일감</b><div class="small muted">기획서 23-1 템플릿</div>',
    `<label class="f">제목 (예: [SL-03] 뼈 셰이프 매칭 소프트바디)</label><input id="n-title" style="width:100%" value="${esc(prefill.title || '')}">
    <div class="row" style="margin-top:6px">${sel('n-phase', PHASES, 'Phase')} ${sel('n-agent', AGENTS, '담당 AI')} ${sel('n-area', AREAS, 'Area')} ${sel('n-owner', PEOPLE, 'Owner')} ${sel('n-checker', CHECKERS, 'Checker')} ${sel('n-pri', PRIORITIES, '우선순위')}</div>
    <div class="row small" style="margin-top:6px"><label><input type="checkbox" id="n-design"> needs-design</label><label><input type="checkbox" id="n-nowan"> no-wan-check</label><label><input type="checkbox" id="n-data"> data-only</label></div>
    <label class="f">본문</label><textarea id="n-body" style="min-height:360px">${esc(prefill.body || taskBody())}</textarea>
    <div class="row" style="margin-top:6px"><button class="btn pri" id="n-create">이슈 만들기</button></div>`);
}
function newBugForm() {
  openDrawer('<b>버그 등록</b><div class="small muted">29장: bug / perf / feel / text + 재현 템플릿</div>',
    `<label class="f">제목</label><input id="b-title" style="width:100%">
    <div class="row" style="margin-top:6px"><select id="b-kind">${BUG_KINDS.map(k => opt(k)).join('')}</select><select id="b-pri">${opt('', '우선순위')}${PRIORITIES.map(p => opt(p)).join('')}</select><select id="b-agent">${opt('', '담당 AI (보통 qa)')}${AGENTS.map(a => opt(a)).join('')}</select></div>
    <label class="f">빌드·환경 (커밋/태그, OS, 입력 장치)</label><input id="b-env" style="width:100%">
    <label class="f">재현 단계</label><textarea id="b-steps" placeholder="1.\n2.\n3."></textarea>
    <label class="f">기대 결과</label><textarea id="b-expect" style="min-height:50px"></textarea>
    <label class="f">실제 결과</label><textarea id="b-actual" style="min-height:50px"></textarea>
    <label class="f">빈도</label><input id="b-freq" style="width:100%" placeholder="예: 10번 중 3번">
    <label class="f">관련 일감 (예: SL-03, #12)</label><input id="b-rel" style="width:100%">
    <label class="f">첨부 (스크린샷·영상 링크, 로그 경로)</label><textarea id="b-att" style="min-height:50px"></textarea>
    <div class="row" style="margin-top:8px"><button class="btn pri" id="b-create">이슈 만들기</button></div>`);
}
function bugBody() {
  const v = id => $(id).value.trim();
  return [`## 환경 / 빌드`, v('#b-env'), '', '## 재현 단계', v('#b-steps'), '', '## 기대 결과', v('#b-expect'), '', '## 실제 결과', v('#b-actual'), '', '## 빈도', v('#b-freq'), '', '## 관련 일감', v('#b-rel'), '', '## 첨부', v('#b-att')].join('\n');
}

// ── 이벤트 ──────────────────────────────────────────────────────────
function switchView(v) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('section.view').forEach(s => s.classList.toggle('on', s.id === `v-${v}`));
  document.body.classList.toggle('wide', v === 'board'); // 칸반은 화면 폭을 다 쓴다
  if (v === 'board') fitBoard();
  try { history.replaceState(null, '', `#${v}`); } catch { /* file:// */ }
}

function bind() {
  $('#tabs').addEventListener('click', e => { const v = e.target.dataset?.view; if (v) switchView(v); });
  document.addEventListener('click', async e => {
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); switchView(go.dataset.goto); return; }
    const nav = !e.target.closest('[data-issue]') && e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); navTo(nav.dataset.nav); return; }
    const card = e.target.closest('[data-issue]');
    if (card && !e.target.closest('#drawer')) { e.preventDefault(); showIssue(card.dataset.issue); return; }
    const prRow = e.target.closest('[data-pr]');
    if (prRow && !e.target.closest('#drawer')) { e.preventDefault(); showPR(prRow.dataset.pr); }
  });
  $('#reload').onclick = () => boot();
  $('#dr-close').onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  // 칸반 필터·드래그
  ['#bf-view', '#bf-phase', '#bf-agent', '#bf-owner', '#bf-status', '#bf-mode', '#bf-closed'].forEach(s => $(s).addEventListener('change', renderBoard));
  $('#bf-q').addEventListener('input', renderBoard);
  const board = $('#board');
  board.addEventListener('dragstart', e => { const c = e.target.closest('.tcard'); if (c) e.dataTransfer.setData('text/plain', c.dataset.issue); });
  board.addEventListener('dragover', e => { const col = e.target.closest('.col'); if (col) { e.preventDefault(); col.classList.add('drop'); } });
  board.addEventListener('dragleave', e => { const col = e.target.closest('.col'); if (col) col.classList.remove('drop'); });
  board.addEventListener('drop', async e => {
    const col = e.target.closest('.col'); if (!col) return;
    e.preventDefault(); col.classList.remove('drop');
    const i = S.issues.find(x => x.number === Number(e.dataTransfer.getData('text/plain')));
    if (!i || i.status === col.dataset.status) return;
    try { await setLabels(i, withSingle(i.labels, 'status:', col.dataset.status)); toast(`#${i.number} → ${col.dataset.status}`); } catch (err) { toast(err.message, 5000); }
  });
  $('#task-new').onclick = () => newTaskForm();

  // 버그
  ['#bt-kind', '#bt-status', '#bt-pri', '#bt-state'].forEach(s => $(s).addEventListener('change', renderBts));
  $('#bt-q').addEventListener('input', renderBts);
  $('#bug-new').onclick = newBugForm;

  // PR
  ['#pr-state', '#pr-all'].forEach(s => $(s).addEventListener('change', renderPRs));

  // 기획서
  $('#plan-version').addEventListener('change', e => loadPlan(e.target.value).then(renderAll).catch(err => toast(err.message, 5000)));
  $('#pt-phase').addEventListener('change', renderPlanTasks);
  $('#pt-list').addEventListener('change', e => { if (e.target.classList.contains('pt-chk')) updatePtButton(); });
  $('#pt-create').onclick = async () => {
    if (demoGuard()) return;
    const ids = [...document.querySelectorAll('.pt-chk:checked')].map(x => x.value);
    if (!confirm(`${ids.length}개 일감을 GitHub 이슈로 만듭니다. 계속할까요?`)) return;
    let ok = 0;
    for (const id of ids) {
      const t = S.planTasks.find(x => x.id === id);
      // 연속 생성은 GitHub 의 짧은 시간 제한(secondary rate limit)에 걸리므로 간격을 둔다
      if (ok) await new Promise(r => setTimeout(r, 1500));
      try { await createIssue(planTaskToIssue(t)); ok++; toast(`이슈 만드는 중 ${ok}/${ids.length}`, 2000); }
      catch (e) { toast(`${ok}개 만든 뒤 ${id} 에서 멈췄습니다. ${e.message}`, 12000); return; }
    }
    toast(`이슈 ${ok}개를 만들었습니다`);
  };
  $('#fb-submit').onclick = async () => {
    const ch = $('#fb-chapter').value, text = $('#fb-text').value.trim();
    if (!text) { toast('내용을 적어 주세요'); return; }
    if (demoGuard()) return;
    const it = await createIssue({ title: `[기획] ${ch || '기획서'} 의견`, body: `대상: 기획서 ${S.planVersion} ${ch}\n\n${text}`, labels: [L.slime, L.plan, L.status('백로그')] }).catch(e => toast(e.message, 5000));
    if (it) { $('#fb-text').value = ''; toast(`#${it.number} 를 만들었습니다`); }
  };
  // 드로어 안 버튼 (위임)
  $('#drawer').addEventListener('click', async e => {
    const id = e.target.id;
    const i = S.current;
    try {
      if (e.target.classList.contains('body-chk')) {
        e.target.disabled = true;
        try { await toggleBodyCheck(i, Number(e.target.dataset.line), e.target.checked); toast(e.target.checked ? '체크했습니다' : '체크를 풀었습니다'); }
        catch (err) { e.target.checked = !e.target.checked; throw err; }
        finally { e.target.disabled = false; }
        return;
      }
      if (id === 'p-approve') await reviewPR('APPROVE');
      else if (id === 'p-changes') await reviewPR('REQUEST_CHANGES');
      else if (id === 'p-comment') await reviewPR('COMMENT');
      else if (id === 'p-merge-btn') { e.target.disabled = true; await mergePR(); }
      else if (id === 'd-save') await saveDrawerLabels();
      else if (id === 'd-run') { if (!i.labels.includes('agent-run')) await setLabels(i, [...i.labels, 'agent-run']); toast('agent-run 라벨을 붙였습니다. 러너가 없으면 라벨만 남습니다.', 4000); showIssue(i.number); }
      else if (id === 'd-prompt') copy(agentPrompt(i));
      else if (id === 'd-close') {
        if (demoGuard()) return;
        const closing = i.state === 'open';
        const labels = closing ? withSingle(i.labels, 'status:', '완료') : i.labels;
        const it = await gh(`/repos/${cfg().repo}/issues/${i.number}`, { method: 'PATCH', body: closing ? { state: 'closed', state_reason: 'completed', labels } : { state: 'open' } });
        replaceIssue(it); showIssue(i.number);
      }
      else if (id === 'd-revise') { $('#d-cmt').value = '/수정 대상: \n아쉬운 점: \n레퍼런스: \n원하는 방향: \n우선순위: \n첨부 VFX 경로: '; }
      else if (id === 'd-cmt-send') {
        const body = $('#d-cmt').value.trim(); if (!body || demoGuard()) return;
        await gh(`/repos/${cfg().repo}/issues/${i.number}/comments`, { method: 'POST', body: { body } });
        toast('댓글을 달았습니다'); showIssue(i.number);
      }
      else if (id === 'n-create') {
        if (demoGuard()) return;
        const title = $('#n-title').value.trim(); if (!title) { toast('제목을 적어 주세요'); return; }
        const labels = [L.slime, L.status('백로그')];
        const add = (v, f) => { if (v) labels.push(f(v)); };
        add($('#n-phase').value, L.phase); add($('#n-agent').value, L.agent); add($('#n-area').value, L.area);
        add($('#n-owner').value, L.owner); add($('#n-checker').value, L.checker); add($('#n-pri').value, x => x);
        if ($('#n-design').checked) labels.push('needs-design');
        if ($('#n-nowan').checked) labels.push('no-wan-check');
        if ($('#n-data').checked) labels.push('data-only');
        const it = await createIssue({ title, body: $('#n-body').value, labels });
        toast(`#${it.number} 를 만들었습니다`); showIssue(it.number);
      }
      else if (id === 'b-create') {
        if (demoGuard()) return;
        const title = $('#b-title').value.trim(); if (!title) { toast('제목을 적어 주세요'); return; }
        const labels = [L.slime, $('#b-kind').value, L.status('백로그')];
        if ($('#b-pri').value) labels.push($('#b-pri').value);
        if ($('#b-agent').value) labels.push(L.agent($('#b-agent').value));
        const it = await createIssue({ title, body: bugBody(), labels });
        toast(`#${it.number} 를 만들었습니다`); showIssue(it.number);
      }
    } catch (err) { toast(err.message, 6000); e.target.disabled = false; }
  });

  // Claude 탭
  $('#inbox-copy').onclick = () => copy(inboxPrompt());

  // 설정
  $('#s-save').onclick = () => {
    store.set('repo', $('#s-repo').value.trim()); store.set('branch', $('#s-branch').value.trim());
    store.set('gh', $('#s-gh').value.trim()); store.set('me', $('#s-me').value);
    toast('저장했습니다'); boot();
  };
  $('#s-forget').onclick = () => { store.del('gh'); fillSettings(); toast('토큰을 지웠습니다'); boot(); };
  $('#s-check').onclick = checkToken;
  $('#s-labels').onclick = async () => {
    if (demoGuard()) return;
    const c = cfg();
    const have = new Set((await ghAll(`/repos/${c.repo}/labels`)).map(l => l.name));
    const missing = allLabelDefs().filter(([n]) => !have.has(n));
    if (!missing.length) { $('#s-label-out').textContent = '필요한 라벨이 모두 있습니다.'; return; }
    if (!confirm(`${c.repo} 에 라벨 ${missing.length}개를 만듭니다 (기존 라벨은 건드리지 않음). 계속할까요?`)) return;
    let ok = 0;
    for (const [name, color, description] of missing) {
      try { await gh(`/repos/${c.repo}/labels`, { method: 'POST', body: { name, color, description } }); ok++; } catch (e) { $('#s-label-out').textContent = e.message; return; }
    }
    $('#s-label-out').textContent = `라벨 ${ok}개를 만들었습니다.`;
  };
}

// 토큰으로 할 수 있는 일을 하나씩 읽어 보고 결과를 줄마다 보여 준다 (쓰기는 실제로 하지 않는다)
async function checkToken() {
  const out = $('#s-check-out');
  const c = cfg();
  const rows = [];
  const line = (kind, text) => { rows.push(`<div class="chk"><b class="${kind === 'PASS' ? 'p' : kind === 'FAIL' ? 'f' : 'w'}">${kind}</b> ${text}</div>`); out.innerHTML = rows.join(''); };
  if (!c.gh) { out.innerHTML = '<div class="chk"><b class="f">FAIL</b> 저장된 토큰이 없습니다. 붙여 넣고 <b>저장</b>을 먼저 누르세요.</div>'; return; }
  out.innerHTML = '확인 중…';
  const kind = c.gh.startsWith('github_pat_') ? 'fine-grained' : c.gh.startsWith('ghp_') ? 'classic' : '알 수 없는 종류';
  try {
    const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${c.gh}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) { line('FAIL', explainGhError(res.status, 'GET', '/user', '')); return; }
    const me = await res.json();
    line('PASS', `토큰이 맞습니다: ${esc(me.login)} (${kind} 토큰)`);
    if (kind === 'classic') {
      const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map(x => x.trim());
      if (scopes.includes('repo')) line('PASS', 'repo 권한이 있습니다');
      else line('FAIL', 'repo 권한이 없습니다. 발급 안내의 classic 토큰 링크로 다시 만드세요 (repo 가 미리 체크됨).');
    }
  } catch (e) { line('FAIL', `GitHub 에 연결하지 못했습니다: ${esc(e.message)}`); return; }
  const step = async (label, path) => {
    try { await gh(path); line('PASS', label); return true; } catch (e) { line('FAIL', esc(e.message)); return false; }
  };
  if (!await step(`${esc(c.repo)} 저장소가 보입니다`, `/repos/${c.repo}`)) return;
  await step('이슈를 읽을 수 있습니다', `/repos/${c.repo}/issues?per_page=1`);
  await step('기획서를 읽을 수 있습니다 (Contents)', `/repos/${c.repo}/contents/${encPath(PLAN_DIR)}?ref=${encodeURIComponent(c.branch)}`);
  await step('PR 을 읽을 수 있습니다 (Pull requests)', `/repos/${c.repo}/pulls?per_page=1`);
  line('INFO', '쓰기 권한(이슈 저장, PR 승인·병합)은 처음 쓸 때 확인됩니다. 「권한이 없습니다」가 나오면 발급 안내 5단계를 보세요.');
}

function fillSettings() {
  const c = cfg();
  $('#s-repo').value = c.repo; $('#s-branch').value = c.branch; $('#s-gh').value = c.gh; $('#s-me').value = c.me;
  $('#label-doc').innerHTML = `<p>모든 일감·버그에 <code>slime</code> 라벨이 붙습니다 (23-1). 기획서 25-2 의 Projects 필드는 Project 가 생기기 전까지 아래 라벨로 대신합니다.</p>
    <table><tr><th>필드</th><th>라벨</th></tr>
    <tr><td>Status</td><td><code>status:작업중</code> 등 ${STATUSES.length}개</td></tr>
    <tr><td>Phase / Agent / Area</td><td><code>phase-1</code> <code>agent-gameplay</code> <code>area-slime</code> (23-1 예시와 같음)</td></tr>
    <tr><td>Owner / Checker</td><td><code>owner:Dong</code> <code>checker:둘 다</code></td></tr>
    <tr><td>Priority</td><td><code>P0</code> <code>P1</code> <code>P2</code></td></tr>
    <tr><td>버그 종류</td><td><code>bug</code> <code>perf</code> <code>feel</code> <code>text</code> (29장)</td></tr>
    <tr><td>기획 의견</td><td><code>기획</code></td></tr>
    <tr><td>플래그</td><td>${FLAGS.map(f => `<code>${f}</code>`).join(' ')}</td></tr></table>`;
}

async function boot() {
  fillSettings();
  try { await loadIssues(); } catch (e) { toast(e.message, 6000); }
  try { await loadPRs(); } catch (e) { S.prs = []; toast(e.message, 6000); }
  try {
    await loadPlanVersions();
    const cur = S.planVersion && S.planVersions.includes(S.planVersion) ? S.planVersion : S.planVersions[0];
    $('#plan-version').innerHTML = S.planVersions.map(v => opt(v, v, v === cur)).join('');
    await loadPlan(cur);
  } catch (e) { toast(e.message, 6000); }
  renderAll();
}

// 자동 갱신: 다른 사람·에이전트가 바꾼 이슈·PR 을 페이지를 다시 열지 않아도 보이게 한다.
// 탭이 보일 때 1분마다, 그리고 탭으로 돌아왔을 때. 기획서 일감 화면에서 고르는 중이면 선택이 풀리지 않게 건너뛴다.
const AUTO_REFRESH_MS = 60000;
let refreshing = false, lastRefresh = Date.now();
async function autoRefresh() {
  if (S.demo || document.hidden || refreshing || document.querySelector('.pt-chk:checked')) return;
  refreshing = true;
  try {
    await loadIssues();
    await loadPRs();
    if (S.current) S.current = S.issues.find(x => x.number === S.current.number) || S.current;
    renderAll();
    lastRefresh = Date.now();
  } catch { /* 다음 차례에 다시 시도 */ }
  finally { refreshing = false; }
}
setInterval(autoRefresh, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastRefresh > 15000) autoRefresh(); });

bind();
const startView = (location.hash || '').slice(1);
switchView(document.getElementById(`v-${startView}`) ? startView : 'dash');
boot();
