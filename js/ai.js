/* AI 解析模块：攻略原文 → 结构化旅行数据（Trip JSON）
 * 只负责"读懂攻略"，不涉及地图和展示。
 * 兼容 Ollama / 任何 OpenAI 格式的 /v1/chat/completions 服务。
 */
import config from './config.js';

const SYSTEM_PROMPT = `你是旅行攻略解析器。从用户提供的攻略文本中提取结构化旅行数据，只输出一个JSON对象，不要输出任何解释、markdown或多余文字。

输出格式：
{
  "title": "给这篇攻略起的简短标题",
  "city": "旅行目的地城市（根据地点推断，如：东京）",
  "hotel": "攻略提到的住宿酒店/民宿名称（没有则填null）",
  "days": [
    {
      "day": 1,
      "locations": [
        {
          "name": "地点名称（规范名称，如：浅草寺）",
          "type": "景点|餐厅|酒店|商圈|交通枢纽|其他",
          "timeOfDay": "上午|下午|晚上|null",
          "durationHours": 2,
          "sourceText": "原文中提到该地点的一句话（尽量保留原文）",
          "lat": 纬度数字或null,
          "lng": 经度数字或null
        }
      ]
    }
  ]
}

提取规则：
1. locations 必须按游玩先后顺序排列。
2. 攻略明确提到 Day/第几天 时按天数分组；没有提到则全部放入 day 1。
3. 只提取真实旅行地点（景点、餐厅、商圈等），忽略评价、建议、费用、交通说明等非地点内容。
4. timeOfDay 根据原文中的"早上/上午/下午/晚上"判断，无法判断填 null。
5. durationHours 是该地点的预计游玩时长（小时数字）：大型景区/乐园3~5，一般景点1.5~2，商圈/美食街1~2，途经打卡点0.5~1。根据地点性质和原文描述估计。
6. lat/lng 是可选的地点大致经纬度估计，不确定就填 null，不要编造精确坐标。
7. hotel 提取攻略中明确提到的住宿地点名称；住宿地点不要再重复放入 locations。
8. city 尽量推断，推断不出来填 ""。`;

/* 解析攻略文本，返回结构化 JSON（未规范化） */
export async function parseGuide(text) {
  const res = await fetch(`${config.ai.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.ai.apiKey}`
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      stream: false
    })
  });

  if (!res.ok) {
    throw new Error(`模型请求失败：HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return extractJSON(content);
}

/* 从模型输出中稳健地抽取 JSON（容忍 ```json 围栏和前后杂文字） */
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('EMPTY_JSON');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error('BAD_JSON');
  }
}
