/* SVG 示意图模式（开发期无高德 Key 时使用）
 * 接口与高德实现完全一致：
 *   render(trip, activeDay) / resolveLocations(trip)
 *   focus(id) / highlight(id) / setOnMarkerClick(cb)
 *   services.travel / findMeal / findPlace（估算版）
 */
const W = 900, H = 640, PAD = 80;
const DAY_COLORS = ['#0071e3', '#ff9f0a', '#34c759', '#af52de', '#ff375f', '#5ac8fa', '#ff6b22'];
const NS = 'http://www.w3.org/2000/svg';

export function svgMap(container, watermark) {
  let trip = null, activeDay = 'all', clickCb = null, highlightId = null;

  /* 规划服务（估算版）：直线距离/22km/h 估耗时，无餐厅搜索 */
  const services = {
    travel(a, b) {
      const R = 6371, rad = d => d * Math.PI / 180;
      const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
      return Promise.resolve({ minutes: Math.max(5, Math.round(2 * R * Math.asin(Math.sqrt(s)) / 22 * 60)), path: null });
    },
    findMeal() { return Promise.resolve(null); },
    findPlace() { return Promise.resolve(null); },
    searchPlaces() { return Promise.resolve([]); }
  };

  function el(tag, attrs = {}) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  /* 无真实坐标时，用地点名做确定性哈希生成伪坐标，保证布局稳定 */
  function pseudoCoords(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return {
      lat: 35.4 + (h % 1000) / 1000 * 0.6,
      lng: 139.4 + ((h >>> 10) % 1000) / 1000 * 0.9
    };
  }

  function ensureCoords(t) {
    t.days.forEach(d => d.locations.forEach(l => {
      if (l.lat == null || l.lng == null) {
        const c = pseudoCoords(l.name);
        l.lat = c.lat; l.lng = c.lng;
      }
    }));
  }

  async function resolveLocations(t) {
    ensureCoords(t); // 示意图模式：AI 估计坐标或伪坐标即可
  }

  function visibleDays() {
    return activeDay === 'all' ? trip.days : trip.days.filter(d => d.day === activeDay);
  }

  function render(t, day) {
    trip = t; activeDay = day;
    draw();
  }

  function draw() {
    container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'svg-map' });
    container.appendChild(svg);

    if (!trip || !trip.days.some(d => d.locations.length)) {
      const txt = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'svg-empty' });
      txt.textContent = '未识别到可显示的地点';
      svg.appendChild(txt);
      return;
    }

    const days = visibleDays();
    const pts = [];
    days.forEach((d, di) => d.locations.forEach((l, i) =>
      pts.push({ loc: l, dayIdx: di, seq: i + 1 })));
    // 酒店与三餐（来自日程）
    if (trip.hotel?.resolved) pts.push({ loc: { ...trip.hotel, id: 'hotel' }, dayIdx: 0, seq: '⌂', special: 'hotel' });
    days.forEach(d => (d.schedule?.entries || []).forEach(e => {
      if (e.kind === 'meal' && e.place?.resolved && e.place.lat != null) {
        pts.push({ loc: e.place, dayIdx: 0, seq: '🍽', special: 'meal' });
      }
    }));
    if (!pts.length) { // 切到空 Day
      const txt = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'svg-empty' });
      txt.textContent = '该天没有地点';
      svg.appendChild(txt);
      return;
    }

    // 坐标归一化到画布
    const lats = pts.map(p => p.loc.lat), lngs = pts.map(p => p.loc.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const X = p => PAD + (p.loc.lng - minLng) / ((maxLng - minLng) || 1) * (W - 2 * PAD);
    const Y = p => H - PAD - (p.loc.lat - minLat) / ((maxLat - minLat) || 1) * (H - 2 * PAD);

    // 按 Day 连线（含耗时标签）
    days.forEach((d, di) => {
      if (d.locations.length < 2) return;
      const color = DAY_COLORS[di % DAY_COLORS.length];
      const line = d.locations.map(l => `${X({ loc: l })},${Y({ loc: l })}`).join(' ');
      svg.appendChild(el('polyline', {
        points: line,
        stroke: color, 'stroke-width': 3.5, fill: 'none',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.75
      }));
      // 每段耗时标签
      (d.schedule?.entries || []).filter(e => e.kind === 'travel').forEach(e => {
        const a = { loc: e.from }, b = { loc: e.to };
        if (e.from?.lat == null || e.to?.lat == null) return;
        const mx = (X(a) + X(b)) / 2, my = (Y(a) + Y(b)) / 2;
        const txt = el('text', { x: mx, y: my - 8, 'text-anchor': 'middle', class: 'svg-dur' });
        txt.textContent = e.minutes >= 60 ? (Math.round(e.minutes / 60 * 10) / 10) + 'h' : e.minutes + '分';
        svg.appendChild(txt);
      });
    });

    // 地点标记：序号圆点 + 名称
    pts.forEach(p => {
      const x = X(p), y = Y(p);
      const color = DAY_COLORS[p.dayIdx % DAY_COLORS.length];
      const g = el('g', { class: 'svg-mk' + (p.loc.id === highlightId ? ' active' : ''), 'data-id': p.loc.id });
      g.style.cursor = 'pointer';

      if (p.loc.id === highlightId) {
        g.appendChild(el('circle', { cx: x, cy: y, r: 22, fill: 'none', stroke: color, 'stroke-width': 2, opacity: 0.6 }));
      }
      g.appendChild(el('circle', { cx: x, cy: y, r: 15, fill: color }));
      const num = el('text', { x, y: y + 4.5, 'text-anchor': 'middle', class: 'svg-num' });
      num.textContent = p.seq;
      g.appendChild(num);

      const label = el('text', { x, y: y + 36, 'text-anchor': 'middle', class: 'svg-label' });
      label.textContent = p.loc.name;
      g.appendChild(label);

      g.addEventListener('click', () => clickCb && clickCb(p.loc.id));
      svg.appendChild(g);
    });

    // 水印（提示当前为示意图模式）
    if (watermark) {
      const wm = el('text', { x: W - 16, y: H - 14, 'text-anchor': 'end', class: 'svg-wm' });
      wm.textContent = watermark;
      svg.appendChild(wm);
    }
  }

  function focus(id) {
    highlightId = id;
    draw();
  }

  function highlight(id) {
    if (highlightId === id) return;
    highlightId = id;
    draw();
  }

  function setOnMarkerClick(cb) { clickCb = cb; }

  return { render, resolveLocations, focus, highlight, setOnMarkerClick, services };
}
