/* 地图适配层：同一接口，两套实现
 * 有高德 Key → 真实地图（POI 定位 + 路线）
 * 无 Key    → SVG 示意图模式（开发期零配置可跑通全流程）
 */
import config from './config.js?v=16';
import { svgMap } from './svg-map.js?v=16';
import { amapMap } from './amap.js?v=16';

export async function createMap(container) {
  if (config.amap.key) {
    try {
      return await amapMap(container, config.amap.key, config.amap.securityJsCode, config.amap.webKey);
    } catch (e) {
      console.warn('高德地图加载失败，降级为示意图模式：', e);
    }
  }
  return svgMap(container, '示意图模式 · 配置高德Key后显示真实地图');
}
