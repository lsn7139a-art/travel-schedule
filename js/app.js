/* 主应用：视图路由、解析流程、分屏联动、行程编辑、日程规划 */
import config from './config.js?v=16';
import { parseGuide } from './ai.js?v=16';
import { normalizeTrip, tripStats, uid } from './model.js?v=16';
import { createMap } from './map.js?v=16';
import { computeDaySchedule, loadBadge, fmtMin, optimizeDayOrder, defaultDuration, suggestMoves, tripCfg } from './planner.js?v=16';
import * as storage from './storage.js?v=16';

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

const state = {
  trip: null,
  map: null,
  mapReady: false,
  editMode: false,
  activeDay: 'all',
  mode: 'original' // original | optimize
};
window.__app = state; // 调试入口

const SAMPLE = `东京5日游超详细路线！

Day1：早上先去浅草寺，人少好拍，雷门合影。然后步行到上野公园，逛阿美横町吃午饭。下午去秋叶原逛电器店，晚上到银座吃饭逛街。

Day2：上午明治神宫，之后逛原宿竹下通，中午表参道吃饭。下午涩谷十字路口打卡，傍晚去东京塔看夜景。

Day3：全天迪士尼乐园，建议开园前到。

Day4：早上筑地场外市场吃海鲜饭，上午台场海滨公园，下午teamLab数字艺术馆，晚上六本木之丘看夜景。

Day5：上午新宿御苑散步，中午思出横丁小吃，下午逛新宿百货，傍晚回国。`;

/* ==================== 视图切换 ==================== */
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
}

$$('.nav-btn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.nav === 'trips') renderTrips();
  showView(b.dataset.nav);
}));

/* ==================== Toast ==================== */
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', 3200);
}

/* ==================== 模型连接状态 ==================== */
(async () => {
  const el = $('#model-status');
  try {
    const r = await fetch(config.ai.baseURL + '/models');
    if (!r.ok) throw 0;
    el.innerHTML = `<span class="dot ok"></span>${config.ai.model} · Ollama 已连接`;
  } catch {
    el.innerHTML = `<span class="dot bad"></span>Ollama 未连接 · 请先运行 ollama serve`;
  }
})();

/* ==================== 解析流程 ==================== */
const STAGES = ['正在抓取链接内容', '正在识别旅行目的地', '正在提取地点', '正在识别游玩顺序', '正在匹配地图位置', '正在规划每日时刻表'];

$('#btn-sample').addEventListener('click', () => { $('#guide-input').value = SAMPLE; });
$('#btn-generate').addEventListener('click', generate);

const FETCH_SVC = 'http://127.0.0.1:7778'; // 本地抓取服务（启动.bat 一并启动）

/* 从分享文案中提取第一条链接（容忍前后缀文字、反引号/括号包裹、尾部标点） */
const URL_RE = /https?:\/\/[^\s`'"<>（）()【】\[\]{}]+/gi;
function extractShareUrl(text) {
  URL_RE.lastIndex = 0;
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[0].replace(/[.,，。!！?？;；~～]+$/, '') || null;
}

async function generate() {
  let text = $('#guide-input').value.trim();
  if (!text) return toast('请先粘贴攻略文字或链接', true);

  // 链接模式：纯链接，或分享文案中含链接（小红书/抖音分享文案较短；已知攻略站点链接总是抓取）
  const KNOWN_LINK = /xhslink\.cn|xiaohongshu\.com|douyin\.com|iesdouyin\.com/i;
  const url = extractShareUrl(text);
  const pureUrl = /^https?:\/\/\S+$/i.test(text);
  const asLink = !!url && (pureUrl || KNOWN_LINK.test(url) || text.length <= 300);

  // 抖音视频：转写要 1-2 分钟，停掉阶段自动推进并把第一阶段文案换掉，避免用户以为卡死
  const isVideoLink = !!url && /douyin\.com|iesdouyin\.com/i.test(url);
  showView('loading');
  const finish = startStages(isVideoLink);
  try {
    if (asLink) {
      let j = null;
      if (isVideoLink) updateStage(0, '正在下载视频语音并转写（约1-2分钟，请稍候）');
      let r;
      try {
        r = await fetch(`${FETCH_SVC}/fetch?url=${encodeURIComponent(url)}`);
      } catch { /* 服务未启动 */ }
      if (r) { try { j = await r.json(); } catch { /* 响应中断 */ } }
      if (j?.ok) {
        text = j.text;
        $('#guide-input').value = text; // 回填，便于查看与修改
        toast(`已从${j.source}提取内容（${text.length}字）`);
      } else if (pureUrl || KNOWN_LINK.test(url)) {
        throw new Error('LINK_FAIL:' + (j?.error || '本地抓取服务未启动，请用 启动.bat 启动项目'));
      }
      // 其余情况（短文案里抓不到的普通网页链接）→ 降级按纯文本解析
    }
    finish(0);

    const raw = await parseGuide(text);
    finish(3);
    const trip = normalizeTrip(raw);
    if (!trip.days.some(d => d.locations.length)) throw new Error('NO_LOCATION');

    state.trip = trip;
    state.editMode = false;
    state.activeDay = 'all';
    state.mode = 'original';

    showView('result');
    await ensureMap();
    finish(4);
    await state.map.resolveLocations(trip);
    finish(5);
    await computeSchedules();
    renderResult();
  } catch (e) {
    console.error(e);
    showView('input');
    toast(friendlyError(e), true);
  }
}

/* 计算每天的日程（时刻表+三餐+交通耗时） */
async function computeSchedules() {
  const trip = state.trip;
  for (const d of trip.days) {
    d.schedule = await computeDaySchedule(trip, d, state.map.services);
  }
}

function startStages(hold = false) {
  const ul = $('#stage-list');
  ul.innerHTML = STAGES.map(s => `<li><span class="st-icon"></span>${s}</li>`).join('');
  const items = $$('li', ul);
  const setStage = n => items.forEach((li, i) => {
    li.className = i < n ? 'done' : i === n ? 'active' : '';
  });
  let cur = 0;
  setStage(0);
  // hold=true（视频转写）：不自动推进，停在第一阶段直到抓取完成
  const timer = hold ? null : setInterval(() => { if (cur < 2) setStage(++cur); }, 1500);
  return n => {
    if (timer) clearInterval(timer);
    items.forEach((li, i) => li.className = i <= n ? 'done' : '');
  };
}

function updateStage(i, label) {
  const li = $$('#stage-list li')[i];
  if (li) li.innerHTML = `<span class="st-icon"></span>${label}`;
}

function friendlyError(e) {
  if (e instanceof TypeError) return `无法连接 Ollama，请确认已运行（ollama serve）并拉取模型（ollama pull ${config.ai.model}）`;
  const m = String(e?.message || e);
  if (m.startsWith('LINK_FAIL:')) return m.slice(10);
  if (m === 'NO_LOCATION') return '没有从攻略中识别出地点，请检查文本内容';
  if (m === 'BAD_JSON' || m === 'EMPTY_JSON') return '模型输出格式异常，请重试或换用更大的模型';
  return '解析失败：' + m.slice(0, 120);
}

async function ensureMap() {
  if (state.mapReady) return;
  state.map = await createMap($('#panel-map'));
  state.map.setOnMarkerClick(id => focusGuideItem(id));
  state.mapReady = true;
}

/* ==================== 结果视图渲染 ==================== */
function renderResult() {
  const trip = state.trip;
  if (!trip) return;

  $('#trip-title').textContent = trip.title;
  const st = tripStats(trip);
  $('#trip-city').textContent = `${trip.city ? trip.city + ' · ' : ''}${st.days}天 · ${st.locations}个地点`;

  const btn = $('#btn-save-trip');
  btn.textContent = state.editMode ? '保存修改' : '保存为我的行程';

  renderHotelChip();
  renderModeToggle();
  renderDayTabs();
  renderGuidePanel();
  renderSuggestions();
  state.map.render(trip, state.activeDay);
}

/* ---------- 「太满」开方：挪动建议条 ---------- */
function renderSuggestions() {
  const box = $('#suggest-box');
  if (!box) return;
  const list = suggestMoves(state.trip);
  if (!list.length) {
    box.innerHTML = '';
    box.classList.remove('show');
    return;
  }
  box.innerHTML = list.map((s, i) => {
    const btn = s.action === 'split'
      ? `<button class="sg-apply" data-sg="${i}">拆分此天</button>`
      : (s.action === 'cut' ? '' : `<button class="sg-apply" data-sg="${i}">应用</button>`);
    return `
    <div class="sg-item">
      <span class="sg-text">${esc(s.reason)}</span>
      ${btn}
    </div>`;
  }).join('');
  box.classList.add('show');
  box.querySelectorAll('.sg-apply').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = list[+btn.dataset.sg];
      if (s.action === 'split') { await splitDay(s.fromDay); return; }
      applyMove(s);
      toast(`已把「${s.locName}」挪到 Day${s.toDay}，正在重算日程……`);
      await recompute();
    });
  });
}

/* 执行挪动：从 fromDay 移除，加到 toDay（按地理位置插入合适位置） */
function applyMove(s) {
  const trip = state.trip;
  const from = trip.days.find(d => d.day === s.fromDay);
  const to = trip.days.find(d => d.day === s.toDay);
  if (!from || !to) return;
  const i = from.locations.findIndex(l => l.name === s.locName);
  if (i === -1) return;
  const [loc] = from.locations.splice(i, 1);
  to.locations.push(loc);
  // 天序号排序保持
  trip.days.sort((a, b) => a.day - b.day);
}

/* ---------- 酒店栏（页面内搜索面板，替代弹窗） ---------- */
function renderHotelChip() {
  const chip = $('#hotel-chip');
  const h = state.trip.hotel;
  chip.textContent = h?.resolved ? `⌂ ${h.name}` : (h?.name ? `⌂ ${h.name}（未定位）` : '⌂ 设置酒店');
  chip.classList.toggle('set', !!h?.resolved);
}

function closeHotelPanel() {
  $('#hotel-panel').classList.remove('show');
}

$('#hotel-chip').addEventListener('click', e => {
  e.stopPropagation();
  const panel = $('#hotel-panel');
  const opening = !panel.classList.contains('show');
  closeAllPopovers();
  if (!opening || !state.trip) return;
  const input = $('#hotel-search-input');
  input.value = state.trip.hotel?.name || '';
  $('#hotel-results').innerHTML = state.trip.hotel
    ? `<div class="hp-tip">当前酒店：${esc(state.trip.hotel.name)}${state.trip.hotel.resolved ? '' : '（未定位）'}</div>`
    : `<div class="hp-tip">输入酒店名称搜索，作为每天出发与返回的锚点</div>`;
  panel.classList.add('show');
  input.focus();
});

/* 点面板外部关闭 */
document.addEventListener('click', e => {
  if (!e.target.closest('#hotel-panel') && !e.target.closest('#hotel-chip') &&
      !e.target.closest('#pace-panel') && !e.target.closest('#pace-chip') &&
      !e.target.closest('#loc-picker-panel')) {
    closeAllPopovers();
  }
});

async function hotelSearch() {
  const n = $('#hotel-search-input').value.trim();
  const box = $('#hotel-results');
  if (!n) return;
  box.innerHTML = '<div class="hp-tip">搜索中……</div>';
  const list = await state.map.services.searchPlaces(n);
  if (!list.length) {
    box.innerHTML = `<div class="hp-tip">没有找到「${esc(n)}」，试试更通用的名称（如：金陵饭店）</div>`;
    return;
  }
  box.innerHTML = list.map((p, i) => `
    <div class="hp-item" data-i="${i}">
      <div class="hp-name">${esc(p.name)}</div>
      <div class="hp-addr">${esc(p.address)}</div>
    </div>`).join('');
  box.querySelectorAll('.hp-item').forEach(el => {
    el.addEventListener('click', async () => {
      const p = list[+el.dataset.i];
      state.trip.hotel = { name: p.name, lat: p.lat, lng: p.lng, resolved: true };
      closeHotelPanel();
      toast(`酒店已设置：${p.name}`);
      try { await recompute(); } catch (err) { console.error(err); renderResult(); }
    });
  });
}

$('#hotel-panel').addEventListener('click', e => e.stopPropagation());
$('#hotel-panel').addEventListener('mousedown', e => e.stopPropagation());

$('#hotel-search-btn').addEventListener('click', e => { e.stopPropagation(); hotelSearch(); });
$('#hotel-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); hotelSearch(); }
});
$('#hotel-clear-btn').addEventListener('click', async e => {
  e.stopPropagation();
  state.trip.hotel = null;
  closeHotelPanel();
  await recompute();
  toast('已清除酒店');
});

/* 统一关闭所有浮层 */
function closeAllPopovers() {
  closeHotelPanel();
  closePacePanel();
  closeLocPicker();
}

/* ---------- 地点选择器（添加/替换，接真实定位） ---------- */
let pickerCtx = null; // { mode:'add'|'replace', day, locId }

function closeLocPicker() {
  $('#loc-picker-panel').classList.remove('show');
  pickerCtx = null;
}

function openLocPicker(ctx, presetName, anchorEl) {
  closeAllPopovers();
  pickerCtx = ctx;
  const panel = $('#loc-picker-panel');
  panel.querySelector('.hp-row input').placeholder =
    ctx.mode === 'add' ? '搜索要添加的地点，如：先锋书店' : '搜索替换地点（保持时段与顺序不变）';
  panel.classList.add('show');

  // 等一帧让布局完成，再按面板实际高度定位
  requestAnimationFrame(() => {
    if (!panel.classList.contains('show')) return;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const margin = 12;
    let left = margin, top = margin;

    if (anchorEl?.getBoundingClientRect) {
      const r = anchorEl.getBoundingClientRect();
      // 横向：贴紧触发按钮左侧，超出右侧就左移
      left = Math.min(r.left, innerWidth - pw - margin);
      left = Math.max(margin, left);
      // 纵向：触发点在视口下半 → 面板出现在它上方（避免挡住它）
      if (r.top > innerHeight / 2) {
        top = r.top - ph - 6;
      } else {
        top = r.bottom + 6;
      }
      top = Math.max(margin, Math.min(innerHeight - ph - margin, top));
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });

  const input = $('#loc-picker-input');
  input.value = presetName || '';
  $('#loc-picker-results').innerHTML = '';
  if (presetName) locPickerSearch();
  else input.focus();
}

async function locPickerSearch() {
  const name = $('#loc-picker-input').value.trim();
  const box = $('#loc-picker-results');
  if (!name) return;
  box.innerHTML = '<div class="hp-tip">搜索中……</div>';
  let list = [];
  try { list = await state.map.services.searchPlaces(name) || []; } catch { /* 忽略 */ }
  if (!list.length) {
    box.innerHTML = '<div class="hp-tip">没有搜到匹配地点，试试更通用的名称</div>';
    return;
  }
  box.innerHTML = list.map((p, i) => `
    <div class="hp-item" data-i="${i}">
      <div class="hp-name">${esc(p.name)}</div>
      <div class="hp-addr">${esc(p.address || '')}</div>
    </div>`).join('');
  box.querySelectorAll('.hp-item').forEach(el => {
    el.addEventListener('click', async () => {
      const p = list[+el.dataset.i];
      applyPicked(p);
      closeLocPicker();
      await recompute();
    });
  });
}

/* 选中候选：添加新地点 / 就地替换既有地点 */
function applyPicked(p) {
  const trip = state.trip;
  if (!trip || !pickerCtx) return;
  if (pickerCtx.mode === 'add') {
    const day = trip.days.find(d => d.day === pickerCtx.day);
    if (!day) return;
    day.locations.push({
      id: uid(), name: p.name, type: '其他', timeOfDay: null,
      durationHours: null, sourceText: '', lat: p.lat, lng: p.lng,
      resolved: true, poiVerified: true
    });
    toast(`已添加「${p.name}」`);
  } else if (pickerCtx.mode === 'replace') {
    const found = trip.days.flatMap(d => d.locations.map(l => ({ l, d })))
      .find(x => x.l.id === pickerCtx.locId);
    if (!found) return;
    const l = found.l;
    // 保留时段/时长/顺序，只换地点本身
    Object.assign(l, { name: p.name, lat: p.lat, lng: p.lng, resolved: true, poiVerified: true, sourceText: '' });
    toast(`已替换为「${p.name}」`);
  }
}

$('#loc-picker-search-btn').addEventListener('click', e => { e.stopPropagation(); locPickerSearch(); });
$('#loc-picker-input').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); locPickerSearch(); }
});
$('#loc-picker-panel').addEventListener('click', e => e.stopPropagation());
$('#loc-picker-panel').addEventListener('mousedown', e => e.stopPropagation());

/* ---------- 节奏设置（每行程可不同） ---------- */
function closePacePanel() {
  $('#pace-panel').classList.remove('show');
}

$('#pace-chip').addEventListener('click', e => {
  e.stopPropagation();
  const panel = $('#pace-panel');
  const opening = !panel.classList.contains('show');
  closeAllPopovers();
  if (!opening || !state.trip) return;
  const cfg = tripCfg(state.trip);
  $('#pace-start').value = cfg.dayStart;
  $('#pace-end').value = cfg.dayEnd;
  $('#pace-lunch').value = cfg.lunchAt;
  $('#pace-dinner').value = cfg.dinnerAt;
  $('#pace-lunch-min').value = cfg.lunchMin;
  $('#pace-dinner-min').value = cfg.dinnerMin;
  panel.classList.add('show');
});

$('#pace-panel').addEventListener('click', e => e.stopPropagation());
$('#pace-panel').addEventListener('mousedown', e => e.stopPropagation());

$('#pace-save-btn').addEventListener('click', async e => {
  e.stopPropagation();
  const trip = state.trip;
  if (!trip) return;
  const start = $('#pace-start').value || '09:00';
  const end = $('#pace-end').value || '21:00';
  if (start >= end) { toast('结束时间得晚于出发时间'); return; }
  const clampMin = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(240, Math.max(15, n)) : def;
  };
  trip.plannerCfg = {
    ...(trip.plannerCfg || {}),
    dayStart: start, dayEnd: end,
    lunchAt: $('#pace-lunch').value || '12:00',
    dinnerAt: $('#pace-dinner').value || '18:30',
    lunchMin: clampMin($('#pace-lunch-min').value, tripCfg(trip).lunchMin),
    dinnerMin: clampMin($('#pace-dinner-min').value, tripCfg(trip).dinnerMin)
  };
  closePacePanel();
  toast('节奏已更新，正在重算时刻表……');
  await recompute();
});

$('#pace-reset-btn').addEventListener('click', async e => {
  e.stopPropagation();
  const trip = state.trip;
  if (!trip) return;
  trip.plannerCfg = null;
  closePacePanel();
  toast('已恢复默认节奏');
  await recompute();
});

/* ---------- 原序 / 智能优化 ---------- */
function renderModeToggle() {
  $$('#mode-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === state.mode));
}

$('#mode-toggle').addEventListener('click', async e => {
  const btn = e.target.closest('[data-mode]');
  if (!btn || btn.dataset.mode === state.mode || !state.trip) return;
  state.mode = btn.dataset.mode;
  renderModeToggle();
  toast(state.mode === 'optimize' ? '正在优化各天顺序……' : '已恢复攻略原序');
  const trip = state.trip;
  if (state.mode === 'optimize') {
    for (const d of trip.days) {
      if (!d.origIds) d.origIds = d.locations.map(l => l.id); // 首次保存原序
      const order = await optimizeDayOrder(trip, d, state.map.services);
      if (order) {
        const byId = new Map(d.locations.map(l => [l.id, l]));
        d.locations = order.map(id => byId.get(id)).filter(Boolean);
      }
    }
  } else {
    for (const d of trip.days) {
      if (d.origIds) {
        const byId = new Map(d.locations.map(l => [l.id, l]));
        d.locations = d.origIds.map(id => byId.get(id)).filter(Boolean);
      }
    }
  }
  await computeSchedules();
  renderResult();
});

/* ---------- Day 切换 ---------- */
function renderDayTabs() {
  const tabs = $('#day-tabs');
  const allBtn = `<button data-day="all" class="${state.activeDay === 'all' ? 'active' : ''}">全部</button>`;
  const dayBtns = state.trip.days
    .map(d => `<button data-day="${d.day}" class="${state.activeDay === d.day ? 'active' : ''}">Day ${d.day}</button>`)
    .join('');
  const addBtn = `<button id="day-add" class="day-add" title="加一天（自由日）">＋</button>`;
  tabs.innerHTML = allBtn + dayBtns + addBtn;
}

/* 加一天/插入新天：追加空天（自由日，自己填安排），序号按数组位置重编
 * 注意：不能用 sort（新天 day 初始为 0 会被排到最前），splice 已就位后直接重编即可
 */
function insertDayAfter(dayNum, locations = []) {
  const trip = state.trip;
  const i = trip.days.findIndex(x => x.day === dayNum);
  const newDay = { day: 0, locations, schedule: null, origIds: null };
  if (i === -1) trip.days.push(newDay);
  else trip.days.splice(i + 1, 0, newDay);
  trip.days.forEach((d, k) => d.day = k + 1); // 按数组位置重编号
  return newDay;
}

$('#day-tabs').addEventListener('click', async e => {
  if (e.target.closest('#day-add')) {
    insertDayAfter(state.trip.days[state.trip.days.length - 1]?.day);
    state.activeDay = state.trip.days[state.trip.days.length - 1].day;
    toast('已加一天，添加你自己的安排吧');
    await recompute();
    return;
  }
  const btn = e.target.closest('[data-day]');
  if (!btn) return;
  state.activeDay = btn.dataset.day === 'all' ? 'all' : +btn.dataset.day;
  renderDayTabs();
  renderGuidePanel();
  state.map.render(state.trip, state.activeDay);
});

/* 拆分超时天：跨过时间窗的地点起，后半段挪到新的一天 */
async function splitDay(dayNum) {
  const trip = state.trip;
  const d = trip.days.find(x => x.day === dayNum);
  if (!d || d.locations.length < 2) return;
  const entries = d.schedule?.entries || [];
  const win = d.schedule?.windowMin || 720;
  const base = entries.length ? entries[0].start : 540;
  let cutId = null;
  for (const e of entries) {
    if (e.kind !== 'visit') continue;
    if (e.start + e.minutes > base + win) { cutId = e.loc.id; break; }
  }
  if (!cutId) { // 兜底：没有明确越界点就按后半拆
    const half = Math.ceil(d.locations.length / 2);
    cutId = d.locations[half]?.id ?? d.locations[d.locations.length - 1].id;
  }
  const idx = d.locations.findIndex(l => l.id === cutId);
  if (idx <= 0) return;
  const moved = d.locations.splice(idx);
  const newDay = insertDayAfter(dayNum, moved);
  state.activeDay = newDay.day;
  toast(`已拆分：${moved.length} 个地点挪到 Day ${newDay.day}`);
  await recompute();
}

/* 删除一天：空天直接删；有地点则并入前一天（Day1 不可删非空天） */
async function deleteDay(dayNum) {
  const trip = state.trip;
  if (trip.days.length <= 1) { toast('至少保留一天', true); return; }
  const i = trip.days.findIndex(d => d.day === dayNum);
  if (i === -1) return;
  const d = trip.days[i];
  if (d.locations.length && i === 0) {
    toast('Day 1 有地点无法删除，先把地点挪到其他天', true);
    return;
  }
  if (d.locations.length && i > 0) {
    trip.days[i - 1].locations.push(...d.locations);
    toast(`已删除 Day ${dayNum}，${d.locations.length} 个地点并入前一天`);
  } else {
    toast(`已删除 Day ${dayNum}`);
  }
  trip.days.splice(i, 1);
  trip.days.forEach((dd, k) => dd.day = k + 1);
  if (state.activeDay !== 'all' && state.activeDay > trip.days.length) {
    state.activeDay = trip.days[trip.days.length - 1].day;
  }
  await recompute();
}

/* ---------- 左侧攻略面板（时刻表模式） ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmtDur = min => min >= 60 ? `${Math.floor(min / 60)}小时${min % 60 ? min % 60 + '分' : ''}` : `${min}分钟`;

function renderGuidePanel() {
  const trip = state.trip;
  const days = state.activeDay === 'all' ? trip.days : trip.days.filter(d => d.day === state.activeDay);
  const panel = $('#panel-guide');

  // 先标记序号（与地图一致），再渲染
  days.forEach(d => d.locations.forEach((l, i) => { l.seq = i + 1; }));

  panel.innerHTML = days.map(d => {
    const badge = loadBadge(d.schedule);
    const travelMin = d.schedule?.travelTotal || 0;
    const entriesHtml = (d.schedule?.entries || []).map(e => {
      if (e.kind === 'travel') {
        const label = e.isReturn ? `返程酒店 · 约${fmtDur(e.minutes)}` : `交通 · 约${fmtDur(e.minutes)}`;
        return `<div class="sch-travel">${label}</div>`;
      }
      if (e.kind === 'meal') {
        return `
        <div class="loc-item meal" data-loc-id="${e.place?.id || ''}">
          <div class="loc-order meal">🍽</div>
          <div class="loc-body">
            <div class="loc-name">${esc(e.place?.name || e.name)}
              <span class="sch-time">${fmtMin(e.start)} - ${fmtMin(e.end)}</span>
            </div>
            <div class="loc-quote">${esc(e.name)} · ${fmtDur(e.minutes)}</div>
          </div>
        </div>`;
      }
      // visit
      const l = e.loc;
      return `
      <div class="loc-item" data-loc-id="${l.id}" data-day-num="${d.day}">
        <div class="loc-order" title="按住拖拽排序（可跨天拖）">${l.seq ?? ''}</div>
        <div class="loc-body">
          <div class="loc-name">${esc(l.name)}
            <span class="badge badge-type">${esc(l.type)}</span>
            <span class="sch-time">${fmtMin(e.start)} - ${fmtMin(e.end)}</span>
            <button data-act="replace" class="loc-replace" title="换个地点（保持时段与顺序）">⇄ 替换</button>
          </div>
          ${l.sourceText ? `<div class="loc-quote">“${esc(l.sourceText)}”</div>` : ''}
          <div class="loc-dur">游玩
            <input class="dur-input" data-act="setdur" data-loc="${l.id}" type="number"
                   min="0.5" max="12" step="0.5" value="${(e.minutes / 60).toFixed(1)}" title="改游玩时长（小时）">
            小时
          </div>
          ${state.editMode ? `
          <div class="loc-edit">
            <button data-act="up" title="上移">↑</button>
            <button data-act="down" title="下移">↓</button>
            <select data-act="moveday" title="移动到">
              ${trip.days.map(dd => `<option value="${dd.day}" ${dd.day === d.day ? 'selected' : ''}>Day ${dd.day}</option>`).join('')}
            </select>
            <button data-act="del" class="danger" title="删除">✕</button>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');

    return `
      <div class="day-section" data-day="${d.day}">
        <div class="day-header">
          <span class="day-tag">DAY ${d.day}</span>
          <span class="day-count">${d.locations.length} 个地点 · 交通${fmtDur(travelMin)}</span>
          <span class="load-badge ${badge.cls}">${badge.text}</span>
          ${trip.days.length > 1 ? `<button data-act="delday" data-day="${d.day}" class="day-del" title="${d.locations.length ? '删除这一天（地点并入前一天）' : '删除这一天'}">✕</button>` : ''}
        </div>
        ${entriesHtml || `<div class="empty-tip">这一天还没有安排 —— 加个地点，或留白做自由活动</div>`}
        <div class="add-loc">
          <button data-act="add" data-day="${d.day}" class="add-loc-btn">＋ 添加地点</button>
        </div>
      </div>`;
  }).join('') || '<div class="empty-tip">该天没有地点</div>';
}

/* ---------- 联动：点左侧 → 地图定位；点地图 → 左侧滚动 ---------- */
/* ---------- 拖拽排序（手柄=序号圆点，支持跨天） ---------- */
let dragLocId = null;

function clearDragMarks() {
  document.querySelectorAll('.loc-item.drag-over-top, .loc-item.drag-over-bottom').forEach(el =>
    el.classList.remove('drag-over-top', 'drag-over-bottom'));
}

/* 只在手柄上按下时才启用 draggable，避免行内输入框与拖拽冲突 */
$('#panel-guide').addEventListener('mousedown', e => {
  const handle = e.target.closest('.loc-item:not(.meal) .loc-order');
  const item = handle?.closest('.loc-item');
  document.querySelectorAll('.loc-item[draggable]').forEach(el => el.removeAttribute('draggable'));
  if (item) item.setAttribute('draggable', 'true');
});

$('#panel-guide').addEventListener('dragstart', e => {
  const item = e.target.closest('.loc-item');
  if (!item || !item.hasAttribute('draggable')) return;
  dragLocId = item.dataset.locId;
  item.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragLocId); } catch { /* IE */ }
  }
});

$('#panel-guide').addEventListener('dragend', () => {
  dragLocId = null;
  clearDragMarks();
  document.querySelectorAll('.loc-item[draggable]').forEach(el => el.removeAttribute('draggable'));
  document.querySelectorAll('.loc-item.dragging').forEach(el => el.classList.remove('dragging'));
});

$('#panel-guide').addEventListener('dragover', e => {
  if (!dragLocId) return;
  const item = e.target.closest('.loc-item:not(.meal)');
  const daySec = e.target.closest('.day-section');
  if (!item && !daySec) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  clearDragMarks();
  if (item && item.dataset.locId !== dragLocId) {
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    item.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
  } else if (daySec && !item) {
    daySec.classList.add('day-drop-hint');
    setTimeout(() => daySec.classList.remove('day-drop-hint'), 400);
  }
});

$('#panel-guide').addEventListener('drop', async e => {
  if (!dragLocId) return;
  e.preventDefault();
  const item = e.target.closest('.loc-item:not(.meal)');
  const daySec = e.target.closest('.day-section');
  const trip = state.trip;
  if (!trip || (!item && !daySec)) return;

  // 从源天移除
  let moved = null;
  for (const d of trip.days) {
    const i = d.locations.findIndex(l => l.id === dragLocId);
    if (i !== -1) { moved = d.locations.splice(i, 1)[0]; break; }
  }
  if (!moved) return;

  if (item && item.dataset.locId !== dragLocId) {
    // 落在某个地点上：按鼠标位置决定插到它前/后
    const targetDayNum = +item.dataset.dayNum || +item.closest('.day-section')?.dataset.day;
    const day = trip.days.find(d => d.day === targetDayNum);
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const ti = day.locations.findIndex(l => l.id === item.dataset.locId);
    day.locations.splice(before ? ti : ti + 1, 0, moved);
  } else if (daySec) {
    // 落在天区块空白处：追加到该天末尾
    const day = trip.days.find(d => d.day === +daySec.dataset.day);
    if (day) day.locations.push(moved);
  }
  dragLocId = null;
  clearDragMarks();
  toast('顺序已更新，正在重算……');
  refreshAfterEdit();
});

$('#panel-guide').addEventListener('click', e => {
  if (e.target.closest('.dur-input')) return; // 点时长输入框不触发地图定位
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    e.stopPropagation(); // 防止打开的选择器浮层被 document 级关闭逻辑立即关掉
    return handleEditAction(actBtn);
  }
  const item = e.target.closest('.loc-item');
  if (item) state.map.focus(item.dataset.locId);
});

function focusGuideItem(locId) {
  const item = $(`.loc-item[data-loc-id="${locId}"]`);
  if (!item) return;
  $$('.loc-item.hl').forEach(x => x.classList.remove('hl'));
  item.classList.add('hl');
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- 编辑操作（我的行程模式） ---------- */
function handleEditAction(btn) {
  const act = btn.dataset.act;
  const trip = state.trip;
  if (act === 'delday') {
    deleteDay(+btn.dataset.day);
    return;
  }
  if (act === 'add') {
    const dayNum = +btn.dataset.day;
    // 点按钮直接开选择器（面板本身就是搜索界面），不再有冗余输入框
    openLocPicker({ mode: 'add', day: dayNum }, '', btn);
    return;
  }
  if (act === 'replace') {
    const item = btn.closest('.loc-item');
    if (item?.dataset.locId) openLocPicker({ mode: 'replace', locId: item.dataset.locId }, null, btn);
    return;
  }

  const item = btn.closest('.loc-item');
  const locId = item?.dataset.locId;
  if (!locId) return;

  const found = trip.days.flatMap(d => d.locations.map(l => ({ l, d }))).find(x => x.l.id === locId);
  if (!found) return;
  const { l, d } = found;
  const idx = d.locations.indexOf(l);

  if (act === 'del') {
    d.locations.splice(idx, 1);
  } else if (act === 'up' && idx > 0) {
    [d.locations[idx - 1], d.locations[idx]] = [d.locations[idx], d.locations[idx - 1]];
  } else if (act === 'down' && idx < d.locations.length - 1) {
    [d.locations[idx + 1], d.locations[idx]] = [d.locations[idx], d.locations[idx + 1]];
  }
  refreshAfterEdit();
}

$('#panel-guide').addEventListener('change', e => {
  // 游玩时长直接输入（小时，支持任意小数，0.5~12）
  const dur = e.target.closest('[data-act="setdur"]');
  if (dur) {
    const v = parseFloat(dur.value);
    if (!Number.isFinite(v)) return;
    const h = Math.min(12, Math.max(0.5, v));
    const loc = state.trip.days.flatMap(d => d.locations).find(l => l.id === dur.dataset.loc);
    if (!loc) return;
    loc.durationHours = h;
    toast(`「${loc.name}」时长已改为 ${h} 小时，正在重算时刻表……`);
    refreshAfterEdit();
    return;
  }
  const sel = e.target.closest('[data-act="moveday"]');
  if (!sel) return;
  const locId = sel.closest('.loc-item')?.dataset.locId;
  const targetDay = +sel.value;
  const trip = state.trip;
  for (const d of trip.days) {
    const i = d.locations.findIndex(l => l.id === locId);
    if (i !== -1) {
      const [loc] = d.locations.splice(i, 1);
      trip.days.find(t => t.day === targetDay)?.locations.push(loc);
      break;
    }
  }
  refreshAfterEdit();
});

async function refreshAfterEdit() {
  const trip = state.trip;
  // 空天保留（可能是用户主动加的自由日），只在完全没有天时兜底
  if (!trip.days.length) trip.days = [{ day: 1, locations: [], schedule: null, origIds: null }];
  await state.map.resolveLocations(trip);
  await computeSchedules();
  renderResult();
}

/* 编辑/酒店/模式切换后的统一刷新（出错也保证界面更新） */
async function recompute() {
  try {
    await state.map.resolveLocations(state.trip);
    await computeSchedules();
  } finally {
    renderResult();
  }
}

/* ---------- 保存行程 ---------- */
$('#btn-save-trip').addEventListener('click', () => {
  const trip = state.trip;
  if (!trip) return;
  if (!trip.id) trip.id = uid();
  // 日程不持久化（加载后按当前顺序重算），只存地点与顺序
  const clone = JSON.parse(JSON.stringify(trip));
  clone.days.forEach(d => { delete d.schedule; });
  storage.saveTrip(clone);
  state.editMode = true;
  renderResult();
  toast('已保存到「我的行程」');
});

/* ---------- 导出行程（Markdown 文件，含时刻表） ---------- */
$('#btn-export').addEventListener('click', () => {
  const t = state.trip;
  if (!t) return;
  const st = tripStats(t);
  const lines = [
    `# ${t.title}`,
    `${t.city ? t.city + ' · ' : ''}${st.days}天 · ${st.locations}个地点`,
    t.hotel?.name ? `住宿：${t.hotel.name}` : '',
    ''
  ];
  t.days.forEach(d => {
    const badge = loadBadge(d.schedule);
    lines.push(`## Day ${d.day}（${badge.text}）`);
    (d.schedule?.entries || []).forEach(e => {
      if (e.kind === 'travel') {
        lines.push(`- ${fmtMin(e.start)} → ${e.isReturn ? '返程酒店' : '前往下一站'}（约${fmtDur(e.minutes)}）`);
      } else if (e.kind === 'meal') {
        lines.push(`- ${fmtMin(e.start)}-${fmtMin(e.end)} 🍽 ${e.place?.name || e.name}（${e.name}）`);
      } else {
        const tags = [e.loc.type].filter(Boolean).join(' · ');
        lines.push(`- ${fmtMin(e.start)}-${fmtMin(e.end)} ${e.loc.name}${tags ? `（${tags}）` : ''}`);
        if (e.loc.sourceText) lines.push(`  > ${e.loc.sourceText}`);
      }
    });
    lines.push('');
  });
  const blob = new Blob([lines.filter(l => l !== undefined).join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.title || '行程'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 Markdown 文件');
});

/* ==================== 我的行程列表 ==================== */
function renderTrips() {
  const list = storage.getTrips();
  const box = $('#trip-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty-tip">还没有保存的行程<br>导入一篇攻略，点击「保存为我的行程」</div>';
    return;
  }
  box.innerHTML = list.sort((a, b) => b.updatedAt - a.updatedAt).map(t => {
    const st = tripStats(t);
    const time = new Date(t.updatedAt).toLocaleString('zh-CN', { hour12: false });
    return `
      <div class="trip-card" data-id="${t.id}">
        <div class="trip-card-body">
          <div class="trip-card-title">${esc(t.title)}</div>
          <div class="trip-card-meta">${esc(t.city || '未知城市')} · ${st.days}天 · ${st.locations}个地点 · ${time}</div>
        </div>
        <div class="trip-card-actions">
          <button class="btn-ghost" data-trip-act="open">打开编辑</button>
          <button class="btn-ghost danger" data-trip-act="del">删除</button>
        </div>
      </div>`;
  }).join('');
}

$('#trip-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-trip-act]');
  const card = e.target.closest('.trip-card');
  if (!card) return;
  const id = card.dataset.id;

  if (btn?.dataset.tripAct === 'del') {
    storage.deleteTrip(id);
    renderTrips();
    toast('已删除');
    return;
  }
  if (btn?.dataset.tripAct === 'open') {
    const trip = storage.getTrips().find(t => t.id === id);
    if (!trip) return;
    state.trip = trip;
    state.editMode = true;
    state.activeDay = 'all';
    state.mode = 'original';
    showView('result');
    await ensureMap();
    await state.map.resolveLocations(trip);
    await computeSchedules();
    renderResult();
  }
});
