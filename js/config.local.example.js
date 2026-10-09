/* ============ 本地私有配置模板（不入库） ============
 * 使用方法：
 *   1. 复制本文件为 js/config.local.js（该文件已被 .gitignore 忽略，不会提交到仓库）
 *   2. 在 https://console.amap.com 申请自己的 Key 后填入下方
 *   3. 保存并刷新页面即可生效，无需改动 js/config.js
 * 高德 Key 留空时自动降级为「示意图模式」，流水线照常运行。
 */
export default {
  amap: {
    key: '',              // Web端(JS API) Key
    securityJsCode: '',   // JS API 安全密钥（高德2.0必填）
    webKey: ''            // Web服务 Key（REST备用）
  }
};
