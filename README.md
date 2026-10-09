# Travel Schedule · 旅游行程规划

基于 **高德地图 + 本地 AI（Ollama + Gemma 3）** 的旅游行程规划工具：粘贴小红书 / 抖音 / 网页攻略链接，自动提取文字内容，由本地运行的开放权重模型生成每日行程，并在地图上可视化。

## 功能特性

- **攻略采集**：本地抓取服务（`server/fetch_server.py`）将小红书笔记、抖音视频（含原声语音转写）、普通网页转成纯文本攻略，纯 Python 标准库实现
- **AI 行程规划**：通过 Ollama 调用本地开放权重模型 **Gemma 3** 生成日程，数据不出本机
- **地图可视化**：高德地图 JS API 展示行程路线；Key 留空时自动降级为示意图模式，流水线照常运行
- **本地优先**：AI 推理与语音转写（FunASR / llama.cpp）全部在本机完成，无云端依赖

## 技术栈

| 模块 | 技术 |
|---|---|
| 前端 | 原生 JavaScript + 高德地图 JS API |
| 后端 | Python 标准库 HTTP 服务（端口 7778） |
| AI 规划 | Ollama（OpenAI 兼容接口）+ Gemma 3（本地开放权重） |
| 语音转写 | FunASR SenseVoice / FSMN-VAD（llama.cpp GGUF 二进制） |

## 目录结构

```
.
├── index.html              # 前端入口
├── css/                    # 样式
├── js/                     # 前端逻辑（config.js 为全局配置）
├── server/
│   ├── fetch_server.py     # 本地抓取服务（小红书/抖音/网页 → 文本）
│   ├── test_fetch.py       # 抓取服务测试
│   └── asr/
│       ├── bin/            # FunASR / llama.cpp 转写二进制（含第三方 README）
│       └── models/         # 语音转写模型（GGUF，需自行下载，见下）
├── prd.md                  # 产品需求文档
├── 启动.bat                # 一键启动
└── 产品核心价值.md
```

## 快速开始

1. **安装依赖**
   - 安装 [Ollama](https://ollama.com) 并拉取本地模型：
     ```bash
     ollama pull gemma3:4b
     ```
   - Python 3（可选，仅抓取服务需要）

2. **下载语音转写模型**（抖音视频原声转写功能需要）
   `server/asr/models/sensevoice-small-f16.gguf`（约 448 MB，超出 GitHub 单文件限制，不随仓库分发）。参考 `server/asr/bin/README.md` 或从 [FunASR GGUF 发布页](https://huggingface.co/FunAudioLLM) 下载，放入 `server/asr/models/`。

3. **启动**
   - 双击 `启动.bat`，或手动：
     ```bash
     python server/fetch_server.py   # 抓取服务，端口 7778
     ```
   - 用浏览器打开 `index.html`。

## 配置说明

所有配置集中在 `js/config.js`：

| 配置项 | 说明 |
|---|---|
| `ai.model` | Ollama 模型名，默认 `gemma3:4b`（本地开放权重） |
| `ai.baseURL` | Ollama 服务地址，默认 `http://127.0.0.1:11434/v1` |
| `amap.key` / `amap.securityJsCode` / `amap.webKey` | 高德开放平台（[console.amap.com](https://console.amap.com)）申请的 Key；留空时自动降级为示意图模式 |

**安全提示**

- 请勿将任何真实 Key、Cookie 提交到仓库。`server/asr/ttwid.txt`（抖音访客 Cookie）由抓取服务在运行时自动生成并缓存，已被 `.gitignore` 忽略。

## 开源许可

[MIT](LICENSE)
