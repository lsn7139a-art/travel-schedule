/* 高德地图实现（配置 Key 后启用）
 * 接口与 SVG 示意图一致：render / resolveLocations / focus / highlight / setOnMarkerClick
 * 额外提供规划服务：services.travel（公交耗时+路径）/ findMeal（附近餐厅）/ findPlace（地点搜索）
 */
const DAY_COLORS = ['#0071e3', '#ff9f0a', '#34c759', '#af52de', '#ff375f', '#5ac8fa', '#ff6b22'];
const CN_BBOX = { minLng: 73.5, maxLng: 135.5, minLat: 18, maxLat: 54 };

function loadAMap(key, securityJsCode) {
  return new Promise((resolve, reject) => {
    if (window.AMap) return resolve();
    window._AMapSecurityConfig = { securityJsCode };
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${key}`;
    s.onload = () => window.AMap ? resolve() : reject(new Error('AMap 未就绪'));
    s.onerror = () => reject(new Error('高德脚本加载失败'));
    document.head.appendChild(s);
  });
}

export async function amapMap(container, key, securityJsCode, webKey) {
  await loadAMap(key, securityJsCode);

  const map = new AMap.Map(container, { zoom: 11, viewMode: '2D', resizeEnable: true });

  let trip = null, activeDay = 'all', clickCb = null;
  let markers = new Map();
  let overlays = [];
  let satelliteLayer = null;

  /* ---------- REST 服务（QPS限流，统一节流） ---------- */
  let lastApiTime = 0;
  async function throttle() {
    const wait = 400 - (Date.now() - lastApiTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastApiTime = Date.now();
  }

  async function searchPOI(city, keyword) {
    await throttle();
    const params = new URLSearchParams({
      keywords: keyword, key: webKey, offset: 1, page: 1, extensions: 'base'
    });
    if (city) params.set('city', city);
    try {
      const r = await fetch(`https://restapi.amap.com/v3/place/text?${params}`);
      const j = await r.json();
      const poi = j?.status === '1' && j.pois?.[0];
      if (!poi) return null;
      const [lng, lat] = (poi.location || '').split(',').map(Number);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null; // 坐标缺失/格式坏 → 当作搜不到
      return { lat, lng, region: `${poi.pname || ''}${poi.cityname || ''}${poi.adname || ''}` };
    } catch {
      return null;
    }
  }

  /* 公交路线：返回 {minutes, path|null}（path 为 [[lng,lat],...] 沿途路径） */
  const travelCache = new Map();
  async function travel(from, to) {
    const ck = `${from.lng},${from.lat}-${to.lng},${to.lat}`;
    if (travelCache.has(ck)) return travelCache.get(ck);
    await throttle();
    let result = null;
    try {
      const params = new URLSearchParams({
        origin: ck.split('-')[0],
        destination: ck.split('-')[1],
        city: trip?.city || '北京',
        key: webKey,
        strategy: 0 // 最快
      });
      const r = await fetch(`https://restapi.amap.com/v3/direction/transit/integrated?${params}`);
      const j = await r.json();
      const transit = j?.status === '1' && j.route?.transits?.[0];
      if (transit && +transit.duration > 0) {
        const path = [];
        (transit.segments || []).forEach(seg => {
          seg.walking?.steps?.forEach(st => st.polyline && path.push(...st.polyline.split(';').map(p => p.split(',').map(Number))));
          seg.bus?.buslines?.forEach(bl => bl.polyline && path.push(...bl.polyline.split(';').map(p => p.split(',').map(Number))));
        });
        result = { minutes: Math.max(5, Math.round(+transit.duration / 60)), path: path.length ? path : null };
      }
    } catch { /* 降级 */ }
    if (!result) result = { minutes: heuristicTravel(from, to), path: null };
    travelCache.set(ck, result);
    return result;
  }

  /* 直线距离兜底估算（海外/公交查询失败时） */
  function heuristicTravel(a, b) {
    const R = 6371, rad = d => d * Math.PI / 180;
    const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return Math.max(5, Math.round(2 * R * Math.asin(Math.sqrt(s)) / 22 * 60));
  }

  /* 地点附近餐厅搜索 */
  async function findMeal(loc) {
    await throttle();
    const params = new URLSearchParams({
      location: `${loc.lng},${loc.lat}`,
      keywords: '餐厅',
      radius: 1500,
      key: webKey,
      offset: 3,
      page: 1,
      sortrule: 'weight'
    });
    try {
      const r = await fetch(`https://restapi.amap.com/v3/place/around?${params}`);
      const j = await r.json();
      const pois = (j?.status === '1' ? j.pois : []) || [];
      // 过滤掉明显不是吃饭的地点（如酒店）
      const eat = pois.find(p => !/酒店|宾馆|民宿/.test(p.name + (p.type || '')));
      if (!eat) return null;
      const [lng, lat] = eat.location.split(',').map(Number);
      // 国内才有效（海外返回的是错误数据）
      if (lng < CN_BBOX.minLng || lng > CN_BBOX.maxLng) return null;
      return { name: eat.name.slice(0, 20), lat, lng };
    } catch {
      return null;
    }
  }

  /* 地点搜索（设置酒店用，单结果） */
  async function findPlace(name) {
    return searchPOI(trip?.city, name);
  }

  /* 地点搜索（多候选版，酒店选择面板用）：带城市约束优先，搜不到去约束全局搜 */
  async function searchPlaces(name) {
    const doSearch = async withCity => {
      await throttle();
      const params = new URLSearchParams({
        keywords: name, key: webKey, offset: 6, page: 1, extensions: 'base'
      });
      if (withCity && trip?.city) params.set('city', trip.city);
      try {
        const r = await fetch(`https://restapi.amap.com/v3/place/text?${params}`);
        const j = await r.json();
        if (j?.status !== '1') return [];
        return (j.pois || []).map(p => {
          const [lng, lat] = p.location.split(',').map(Number);
          return {
            name: (p.name || '').slice(0, 30),
            address: [p.address, p.adname || p.cityname].filter(Boolean).join(' · ').slice(0, 40),
            lat, lng
          };
        }).filter(p => p.name);
      } catch {
        return [];
      }
    };
    let list = await doSearch(true);
    if (!list.length) list = await doSearch(false);
    return list;
  }

  const services = { travel, findMeal, findPlace, searchPlaces };

  /* ---------- 坐标解析 ---------- */
  async function resolveLocations(t) {
    trip = t;
    // 酒店定位
    if (t.hotel && !t.hotel.resolved) {
      const r = t.city ? await searchPOI(t.city, t.hotel.name) : null;
      if (r) { t.hotel.lat = r.lat; t.hotel.lng = r.lng; t.hotel.resolved = true; }
    }
    for (const d of t.days) {
      for (const l of d.locations) {
        if (l.resolved) continue;
        let poi = null;
        try {
          if (t.city) {
            const r = await searchPOI(t.city, l.name);
            if (r && r.region.includes(t.city)) poi = r;
          }
          if (!poi && !t.city) {
            const r = await searchPOI('', l.name);
            if (r) poi = r;
          }
        } catch { /* 忽略单个失败 */ }
        if (poi) {
          l.lat = poi.lat; l.lng = poi.lng; l.resolved = true; l.poiVerified = true;
        } else if (Number.isFinite(+l.lat) && Number.isFinite(+l.lng)) {
          l.lat = +l.lat; l.lng = +l.lng; l.resolved = true; l.poiVerified = false;
        }
      }
    }
  }

  /* ---------- 渲染 ---------- */
  function clearOverlays() {
    map.remove(overlays);
    overlays = [];
    markers = new Map();
  }

  function markerContent(seq, color, active, meal) {
    if (meal) return `<div class="amap-mk meal${active ? ' active' : ''}">🍽</div>`;
    return `<div class="amap-mk${active ? ' active' : ''}" style="background:${color}">${seq}</div>`;
  }

  function render(t, day) {
    trip = t; activeDay = day;
    clearOverlays();
    if (!trip) return;

    const days = activeDay === 'all' ? trip.days : trip.days.filter(d => d.day === activeDay);
    const resolvedLocs = [];

    days.forEach((d, di) => {
      const color = DAY_COLORS[di % DAY_COLORS.length];
      const pts = d.locations.filter(l => l.resolved && Number.isFinite(l.lat) && Number.isFinite(l.lng));
      resolvedLocs.push(...pts);

      // 路线：优先用日程条目（含酒店锚点往返与公交路径），无日程则直线
      if (pts.length > 1) {
        let path = null;
        if (d.schedule?.entries?.length) {
          path = [];
          d.schedule.entries.forEach(e => {
            const p = e.kind === 'travel' ? null
              : (e.loc ? [e.loc.lng, e.loc.lat] : (e.place ? [e.place.lng, e.place.lat] : null));
            if (p) path.push(p);
            if (e.kind === 'travel' && e.path) path.push(...e.path);
          });
        } else {
          path = pts.map(l => [l.lng, l.lat]);
        }
        if (path.length > 1) {
          const line = new AMap.Polyline({
            path, strokeColor: color, strokeWeight: 4,
            strokeOpacity: 0.85, showDir: true, lineJoin: 'round'
          });
          map.add(line);
          overlays.push(line);

          // 每段交通耗时标签（取路线中点）
          (d.schedule?.entries || []).filter(e => e.kind === 'travel').forEach(e => {
            const seg = (e.path && e.path.length ? e.path : null) ||
              [[e.from.lng, e.from.lat], [e.to.lng, e.to.lat]];
            if (!seg || seg.length < 2) return;
            const mid = seg[Math.floor(seg.length / 2)];
            const mk = new AMap.Marker({
              position: mid,
              content: `<div class="amap-dur">${e.minutes >= 60 ? Math.round(e.minutes / 60 * 10) / 10 + 'h' : e.minutes + '分'}</div>`,
              anchor: 'center',
              zIndex: 90
            });
            map.add(mk);
            overlays.push(mk);
          });
        }
      }

      // 序号标记
      pts.forEach((l, i) => {
        const mk = new AMap.Marker({
          position: [l.lng, l.lat],
          content: markerContent(i + 1, color, false, false),
          anchor: 'center',
          title: l.name
        });
        mk._seq = i + 1; mk._color = color; mk._meal = false;
        mk.setLabel({ content: `<span class="amap-label">${l.name}</span>`, direction: 'top', offset: new AMap.Pixel(0, -4) });
        mk.on('click', () => clickCb && clickCb(l.id));
        map.add(mk);
        overlays.push(mk);
        markers.set(l.id, mk);
      });

      // 三餐标记（来自日程）
      (d.schedule?.entries || []).filter(e => e.kind === 'meal' && e.place?.resolved
        && Number.isFinite(e.place.lat) && Number.isFinite(e.place.lng)).forEach(e => {
        const p = e.place;
        if (markers.has(p.id)) return;
        const mk = new AMap.Marker({
          position: [p.lng, p.lat],
          content: markerContent(0, '', false, true),
          anchor: 'center',
          title: p.name
        });
        mk._seq = 0; mk._color = '#ff9f0a'; mk._meal = true;
        mk.setLabel({ content: `<span class="amap-label">${p.name}</span>`, direction: 'top', offset: new AMap.Pixel(0, -4) });
        mk.on('click', () => clickCb && clickCb(p.id));
        map.add(mk);
        overlays.push(mk);
        markers.set(p.id, mk);
      });
    });

    // 酒店标记 ⌂
    if (trip.hotel?.resolved) {
      const mk = new AMap.Marker({
        position: [trip.hotel.lng, trip.hotel.lat],
        content: `<div class="amap-mk hotel">⌂</div>`,
        anchor: 'center',
        title: trip.hotel.name
      });
      mk._seq = 0; mk._color = '#1d1d1f'; mk._meal = false;
      mk.setLabel({ content: `<span class="amap-label">${trip.hotel.name}</span>`, direction: 'top', offset: new AMap.Pixel(0, -4) });
      map.add(mk);
      overlays.push(mk);
      markers.set('hotel', mk);
    }

    // 海外行程叠加卫星图层
    const overseas = resolvedLocs.length > 0 &&
      resolvedLocs.every(l => l.lng < CN_BBOX.minLng || l.lng > CN_BBOX.maxLng ||
                               l.lat < CN_BBOX.minLat || l.lat > CN_BBOX.maxLat);
    if (overseas && !satelliteLayer) {
      satelliteLayer = new AMap.TileLayer.Satellite();
      map.add(satelliteLayer);
    } else if (!overseas && satelliteLayer) {
      map.remove(satelliteLayer);
      satelliteLayer = null;
    }

    if (resolvedLocs.length) map.setFitView(overlays, false, [60, 60, 60, 60]);
  }

  function focus(id) {
    const mk = markers.get(id);
    const found = id === 'hotel' ? trip?.hotel
      : trip?.days.flatMap(d => d.locations).find(l => l.id === id)
      || trip?.days.flatMap(d => d.schedule?.entries || []).find(e => e.place?.id === id)?.place;
    if (mk && found) {
      mk.setContent(markerContent(mk._seq, mk._color, true, mk._meal));
      map.setZoomAndCenter(15, [found.lng, found.lat]);
    }
    highlight(id);
  }

  function highlight(id) {
    markers.forEach((mk, mid) => {
      mk.setContent(markerContent(mk._seq, mk._color, mid === id, mk._meal));
    });
  }

  function setOnMarkerClick(cb) { clickCb = cb; }

  return { render, resolveLocations, focus, highlight, setOnMarkerClick, services };
}
