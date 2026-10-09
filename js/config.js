/* ================= 全局配置 =================
 * 模型：Ollama 本地服务（OpenAI 兼容接口），默认使用本地开放权重 Gemma 3
 *       首次使用先执行：ollama pull gemma3:4b
 * 地图：高德 Key 留空时自动降级为「示意图模式」，流水线照常运行
 *       在 https://console.amap.com 申请自己的 Key 填入下方即可
 *       （切勿将真实 Key 提交到公开仓库）
 */
export default {
  ai: {
    baseURL: 'http://127.0.0.1:11434/v1', // Ollama 本地地址
    model: 'gemma3:4b',                   // 本地开放权重模型（ollama pull gemma3:4b）
    apiKey: 'ollama'                      // Ollama 不校验，占位即可
  },
  amap: {
    key: '',                              // Web端(JS API) Key：在 console.amap.com 申请后填入
    securityJsCode: '',                   // JS API 安全密钥（高德2.0必填），随 Key 一起申请
    webKey: ''                            // Web服务 Key（REST备用）
  },

  /* 日程规划默认参数 */
  planner: {
    dayStart: '09:00',  // 每天出发时间
    dayEnd: '21:00',    // 每天结束时间
    lunchAt: '12:00',   // 午餐时间
    dinnerAt: '18:00',  // 晚餐时间
    lunchMin: 60,       // 午餐时长（分钟）
    dinnerMin: 90       // 晚餐时长（分钟）
  }
};
