/* 数据模型：Trip / Day / Location 的规范化与工具函数 */

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* 把 AI 输出的原始 JSON 规范化为内部数据结构，并做容错清洗 */
export function normalizeTrip(raw) {
  const out = {
    id: null, // 保存到「我的行程」时才分配
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 40) : '未命名行程',
    city: typeof raw?.city === 'string' ? raw.city.trim().slice(0, 20) : '',
    hotel: null, // {name, lat, lng, resolved}
    days: []
  };

  // 酒店：AI 单独提取的 hotel 字段，或 locations 中 type=酒店 的第一个
  if (typeof raw?.hotel === 'string' && raw.hotel.trim() && raw.hotel !== 'null') {
    out.hotel = { name: raw.hotel.trim().slice(0, 40), lat: null, lng: null, resolved: false };
  }

  const rawDays = Array.isArray(raw?.days) && raw.days.length
    ? raw.days
    : [{ day: 1, locations: [] }];

  rawDays.forEach((d, i) => {
    const locs = (Array.isArray(d?.locations) ? d.locations : [])
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => {
        if (normalizeType(l.type) === '酒店') {
          // 酒店不进游玩序列；若还没有酒店记录则采用第一个
          if (!out.hotel) out.hotel = { name: l.name.trim().slice(0, 40), lat: null, lng: null, resolved: false };
          return null;
        }
        let dur = +l.durationHours;
        dur = Number.isFinite(dur) ? Math.min(8, Math.max(0.5, dur)) : null;
        return {
          id: uid(),
          name: l.name.trim().slice(0, 30),
          type: normalizeType(l.type),
          timeOfDay: ['上午', '下午', '晚上'].includes(l.timeOfDay) ? l.timeOfDay : null,
          durationHours: dur,
          sourceText: typeof l.sourceText === 'string' ? l.sourceText.trim().slice(0, 200) : '',
          lat: Number.isFinite(+l.lat) ? +l.lat : null,
          lng: Number.isFinite(+l.lng) ? +l.lng : null,
          resolved: false // 坐标是否经过地图API确认
        };
      })
      .filter(Boolean);
    if (locs.length) out.days.push({ day: Number.isFinite(+d?.day) && +d.day > 0 ? +d.day : i + 1, locations: locs, schedule: null, origIds: null });
  });

  if (!out.days.length) out.days = [{ day: 1, locations: [], schedule: null, origIds: null }];
  out.days.sort((a, b) => a.day - b.day);
  return out;
}

const TYPES = ['景点', '餐厅', '酒店', '商圈', '交通枢纽'];
function normalizeType(t) {
  return TYPES.includes(t) ? t : '其他';
}

/* 统计信息 */
export function tripStats(trip) {
  const total = trip.days.reduce((n, d) => n + d.locations.length, 0);
  return { days: trip.days.length, locations: total };
}

/* 在行程中查找地点所在 day 索引与位置索引 */
export function findLocation(trip, locId) {
  for (let di = 0; di < trip.days.length; di++) {
    const li = trip.days[di].locations.findIndex(l => l.id === locId);
    if (li !== -1) return { dayIndex: di, locIndex: li, loc: trip.days[di].locations[li] };
  }
  return null;
}
