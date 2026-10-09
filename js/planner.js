/* 日程引擎：酒店锚点 + 游玩时长 + 交通耗时 + 三餐插入 + 顺序优化
 * 输出每天的 schedule：[{kind:'travel'|'visit'|'meal', ...}]
 */
import config from './config.js';

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fmtMin = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* 各类型地点的默认游玩时长（小时），AI 未估计时使用 */
const DEFAULT_DUR = { '景点': 2, '商圈': 1.5, '餐厅': 1, '酒店': 0, '交通枢纽': 0.5, '其他': 1 };
export function defaultDuration(type) { return DEFAULT_DUR[type] ?? 1; }

/* 直线距离估算交通耗时（海外/无公交数据时的兜底，按综合速度22km/h） */
export function haversineMin(a, b) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.max(5, Math.round(2 * R * Math.asin(Math.sqrt(s)) / 22 * 60));
}

/* 计算一天的日程（async：需要交通耗时与餐厅查询服务）
 * services: { travel(from,to)->{minutes,path|null}, findMeal(loc)->{name,lat,lng}|null }
 */
/* 行程级节奏参数：行程自带设置覆盖全局默认（每行程可不同） */
export function tripCfg(trip) {
  return { ...config.planner, ...(trip?.plannerCfg || {}) };
}

export async function computeDaySchedule(trip, day, services) {
  const cfg = tripCfg(trip);
  const entries = [];
  const seq = day.locations.filter(l => l.resolved && l.lat != null);
  const hotel = trip.hotel && trip.hotel.resolved ? trip.hotel : null;
  const used = new Set();
  let cur = hotel, t = toMin(cfg.dayStart), travelTotal = 0, mealTotal = 0;

  const needMeal = time => {
    if (!mealLunch && time >= toMin(cfg.lunchAt) - 45) return 'lunch';
    if (!mealDinner && time >= toMin(cfg.dinnerAt) - 45) return 'dinner';
    return null;
  };
  let mealLunch = false, mealDinner = false;

  async function go(next) {
    if (!next || cur === next) return;
    if (!cur) { cur = next; return; } // 无酒店锚点时，首个地点成为路线起点（不算交通）
    const r = await services.travel(cur, next);
    entries.push({ kind: 'travel', from: cur, to: next, minutes: r.minutes, start: t, end: t + r.minutes, path: r.path });
    t += r.minutes; travelTotal += r.minutes;
    cur = next;
  }

  function addMeal(kind, place) {
    const lunch = kind === 'lunch';
    const dur = lunch ? cfg.lunchMin : cfg.dinnerMin;
    entries.push({ kind: 'meal', mealKind: kind, name: lunch ? '午餐' : '晚餐', place, start: t, end: t + dur, minutes: dur });
    t += dur; mealTotal += dur;
    if (lunch) mealLunch = true; else mealDinner = true;
  }

  for (const loc of seq) {
    if (used.has(loc.id)) continue;

    // 到饭点且下一站不是餐厅 → 先用餐再去下一站
    let mk = needMeal(t);
    if (mk && loc.type !== '餐厅') {
      const rest = seq.find(l => l.type === '餐厅' && !used.has(l.id)); // 攻略里的餐厅优先
      if (rest) {
        used.add(rest.id);
        await go(rest);
        addMeal(mk, rest);
      } else {
        const anchor = cur || loc; // 在当前位置附近找
        const found = await services.findMeal(anchor); // 附近餐厅推荐补位
        if (found) {
          const mealLoc = { id: 'meal_' + loc.id, name: found.name, type: '餐厅', lat: found.lat, lng: found.lng, resolved: true };
          await go(mealLoc);
          addMeal(mk, mealLoc);
        } else {
          addMeal(mk, { id: 'meal_near_' + loc.id, name: mk === 'lunch' ? '午餐（附近自选）' : '晚餐（附近自选）', lat: anchor.lat, lng: anchor.lng, resolved: true });
        }
      }
    }

    await go(loc);
    // 到达时已过饭点（交通耗时导致）→ 到达后用餐
    mk = needMeal(t);
    if (mk && loc.type !== '餐厅') {
      const rest = seq.find(l => l.type === '餐厅' && !used.has(l.id));
      if (rest) {
        used.add(rest.id);
        await go(rest);
        addMeal(mk, rest);
      } else {
        const found = await services.findMeal(loc);
        if (found) {
          const mealLoc = { id: 'meal_' + loc.id + '_b', name: found.name, type: '餐厅', lat: found.lat, lng: found.lng, resolved: true };
          await go(mealLoc);
          addMeal(mk, mealLoc);
        } else {
          addMeal(mk, { id: 'meal_near_' + loc.id + '_b', name: mk === 'lunch' ? '午餐（附近自选）' : '晚餐（附近自选）', lat: loc.lat, lng: loc.lng, resolved: true });
        }
      }
    }

    const dur = Math.round((loc.durationHours ?? defaultDuration(loc.type)) * 60);
    entries.push({ kind: 'visit', loc, start: t, end: t + dur, minutes: dur });
    t += dur;
    used.add(loc.id);
  }

  // 晚饭还没吃且已过饭点
  if (!mealDinner && seq.length && t >= toMin(cfg.dinnerAt) - 45) {
    const anchor = cur || seq[seq.length - 1];
    addMeal('dinner', { id: 'meal_end', name: '晚餐（附近自选）', lat: anchor.lat, lng: anchor.lng, resolved: Number.isFinite(anchor.lat) && Number.isFinite(anchor.lng) });
  }
  // 返程酒店
  if (hotel && cur !== hotel && seq.length) {
    const r = await services.travel(cur, hotel);
    entries.push({ kind: 'travel', from: cur, to: hotel, minutes: r.minutes, start: t, end: t + r.minutes, path: r.path, isReturn: true });
    t += r.minutes; travelTotal += r.minutes;
  }

  const totalMin = t - toMin(cfg.dayStart);
  return { entries, totalMin, travelTotal, mealTotal, windowMin: toMin(cfg.dayEnd) - toMin(cfg.dayStart) };
}

/* 日程负载评级 */
export function loadBadge(s) {
  if (!s || !s.entries.some(e => e.kind === 'visit')) return { text: '空闲', cls: 'load-easy' };
  if (s.totalMin > s.windowMin) return { text: `太满 +${s.totalMin - s.windowMin}分`, cls: 'load-over' };
  if (s.totalMin >= s.windowMin * 0.83) return { text: '较满', cls: 'load-full' };
  if (s.totalMin <= s.windowMin * 0.4) return { text: '空闲', cls: 'load-easy' };
  return { text: '刚好', cls: 'load-ok' };
}

/* 「太满」开方：给出挪动建议（纯本地计算，不调AI）
 * 逻辑：超时的天里挑游玩耗时最长的地点，尝试挪到剩余空闲最多、且距离影响可控的天。
 * 返回 [{fromDay, toDay, locName, freeMin}] 或 []
 */
export function suggestMoves(trip) {
  const suggestions = [];
  const win = toMin(tripCfg(trip).dayEnd) - toMin(tripCfg(trip).dayStart);
  const days = trip.days.filter(d => d.locations.length);

  for (const d of days) {
    const over = (d.schedule?.totalMin || 0) - (d.schedule?.windowMin || win);
    if (over <= 30) continue; // 容忍半小时内的误差

    // 通用选项：拆分此天（后半段挪到新的一天）
    if (d.locations.length >= 2) {
      suggestions.push({
        fromDay: d.day, action: 'split',
        reason: `Day${d.day} 超${Math.round(over)}分钟：觉得节奏太赶的话，可以拆成两天（后半段挪到新的一天）`
      });
    }

    // 候选：该天游玩耗时最长的地点（跳过餐厅；优先排除"晚上"类——夜景挪走就失去意义）
    let visits = d.locations.filter(l => l.type !== '餐厅' && l.timeOfDay !== '晚上');
    if (!visits.length) visits = d.locations.filter(l => l.type !== '餐厅');
    if (!visits.length) continue;
    const cand = visits.reduce((a, b) =>
      ((b.durationHours ?? defaultDuration(b.type)) > (a.durationHours ?? defaultDuration(a.type)) ? b : a));
    const need = Math.round((cand.durationHours ?? defaultDuration(cand.type)) * 60);

    // 目标天：剩余容量最大且不为自己的天（允许目标天也偏满，只要装得下）
    const others = days.filter(x => x !== d);
    if (others.length) {
      const target = others.reduce((a, b) =>
        (win - (a.schedule?.totalMin || 0)) > (win - (b.schedule?.totalMin || 0)) ? a : b);
      const free = win - (target.schedule?.totalMin || 0);
      if (free >= need) {
        suggestions.push({
          fromDay: d.day, toDay: target.day, locName: cand.name,
          freeMin: free, needMin: need,
          reason: `Day${d.day} 超${Math.round(over)}分钟：把「${cand.name}」（约${fmtDur(need)}）挪到 Day${target.day}（还空${fmtDur(free)}）`
        });
        continue;
      }
      if (free > 0) {
        suggestions.push({
          fromDay: d.day, action: 'cut', locName: cand.name,
          reason: `Day${d.day} 超${Math.round(over)}分钟，Day${target.day} 只空${fmtDur(free)}：建议删掉或缩短「${cand.name}」（约${fmtDur(need)}）`
        });
        continue;
      }
    }
    // 所有天都排满：总容量不够，建议删减最耗时地点或多加一天
    suggestions.push({
      fromDay: d.day, action: 'cut', locName: cand.name,
      reason: `每天都很满：建议删掉或缩短「${cand.name}」（约${fmtDur(need)}），或多安排一天`
    });
  }
  return suggestions;
}

const fmtDur = min => min >= 60 ? `${Math.floor(min / 60)}小时${min % 60 ? min % 60 + '分' : ''}` : `${min}分钟`;

/* 智能优化：以酒店为锚点，最近邻 + 2-opt 重排当天顺序，最小化总交通耗时
 * 尊重时段约束：有 timeOfDay 的地点按 上午→下午→晚上 分组，组内地理优化，组间不跨界
 */
export async function optimizeDayOrder(trip, day, services) {
  const pts = day.locations.filter(l => l.resolved && l.lat != null);
  if (pts.length < 3) return null;
  const hotel = trip.hotel && trip.hotel.resolved ? trip.hotel : null;

  /* 按 timeOfDay 分桶（null 归入"无约束"） */
  const SLOT_ORDER = ['上午', '下午', '晚上'];
  const buckets = { '上午': [], '下午': [], '晚上': [], '无': [] };
  pts.forEach(l => (buckets[l.timeOfDay && SLOT_ORDER.includes(l.timeOfDay) ? l.timeOfDay : '无'].push(l)));
  const hasConstrained = buckets['上午'].length + buckets['下午'].length + buckets['晚上'].length > 0;

  /* 单桶内做最近邻+2-opt（起点为当前位置：可能是酒店或上一个桶的末点） */
  async function solveBucket(list, startNode) {
    if (list.length <= 1) return { order: list, end: list[0] || startNode };
    const nodes = startNode ? [startNode, ...list] : list;
    const M = [];
    for (let i = 0; i < nodes.length; i++) {
      M[i] = M[i] || [];
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) { M[i][j] = 0; continue; }
        if (M[j] && M[j][i] !== undefined) { M[i][j] = M[j][i]; continue; }
        M[i][j] = (await services.travel(nodes[i], nodes[j])).minutes;
        if (!M[j]) M[j] = [];
        M[j][i] = M[i][j];
      }
    }
    const startIdx = startNode ? 0 : -1;
    const visitIdx = list.map((_, i) => i + (startNode ? 1 : 0));
    const cost = (a, b) => M[a][b];

    const unvisited = new Set(visitIdx);
    let curIdx = startIdx >= 0 ? startIdx : visitIdx[0];
    if (startIdx < 0) unvisited.delete(visitIdx[0]);
    const order = [];
    while (unvisited.size) {
      let best = null, bestC = Infinity;
      for (const u of unvisited) {
        const c = cost(curIdx, u);
        if (c < bestC) { bestC = c; best = u; }
      }
      order.push(best); unvisited.delete(best); curIdx = best;
    }

    // 2-opt（开放路径：不强制回到起点）
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const before = i === 0
            ? (startIdx >= 0 ? cost(startIdx, order[0]) : 0)
            : cost(order[i - 1], order[i]);
          const after = j + 1 < order.length ? cost(order[j], order[j + 1]) : 0;
          const nBefore = i === 0
            ? (startIdx >= 0 ? cost(startIdx, order[j]) : 0)
            : cost(order[i - 1], order[j]);
          const nAfter = j + 1 < order.length ? cost(order[i], order[j + 1]) : 0;
          if (nBefore + nAfter < before + after) {
            const seg = order.slice(i, j + 1).reverse();
            order.splice(i, seg.length, ...seg);
            improved = true;
          }
        }
      }
    }
    const orderedLocs = order.map(i => nodes[i]);
    return { order: orderedLocs, end: orderedLocs[orderedLocs.length - 1] };
  }

  let finalOrder = [];
  if (!hasConstrained) {
    // 无任何时段信息：整体优化（与之前行为一致）
    const r = await solveBucket(pts, hotel);
    finalOrder = r.order;
  } else {
    // 有时段约束：上午→下午→晚上 依次解，无约束地点平均填进各桶尾
    let carry = hotel;
    const constrained = ['上午', '下午', '晚上'].map(s => ({ slot: s, list: buckets[s] }));
    // 无约束地点尽量贴近已确定组：先平均分配
    const free = buckets['无'];
    const groups = [...constrained];
    free.forEach((l, i) => {
      // 分给最空的桶（含无约束桶兜底）
      let target = groups.reduce((a, b) => a.list.length <= b.list.length ? a : b);
      target.list.push(l);
    });
    for (const g of groups) {
      if (!g.list.length) continue;
      const r = await solveBucket(g.list, carry);
      finalOrder.push(...r.order);
      carry = r.end || carry;
    }
  }

  return finalOrder.map(l => l.id);
}
