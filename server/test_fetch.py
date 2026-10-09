# -*- coding: utf-8 -*-
"""小红书抓取逻辑离线测试：用模拟的小红书页面HTML验证提取函数"""
import sys
sys.path.insert(0, "server")
from fetch_server import fetch_xhs, fetch_douyin

# 模拟小红书分享页（og标签 + SSR desc 两种来源）
xhs_page = '''<!DOCTYPE html>
<html><head>
<meta name="og:title" content="东京5日游保姆级攻略｜第一次去必看">
<meta name="og:description" content="Day1 浅草寺→上野公园→秋叶原→银座">
<script>window.__INITIAL_STATE__={"note":{"noteData":{"desc":"Day1 早上浅草寺人少好拍，然后上野公园，中午阿美横町吃饭，下午秋叶原，晚上银座。Day2 明治神宫→原宿→涩谷→东京塔夜景。Day3 迪士尼一整天。附交通卡购买攻略和花费明细。"}}}</script>
</head><body>...</body></html>'''

result = fetch_xhs(xhs_page)
print("小红书提取结果：")
print(result)
assert result and "浅草寺" in result and "迪士尼" in result, "提取失败"
print("\n[通过] og标签与SSR正文都正确提取，且取了更长的SSR版本")

# 模拟抖音分享页
dy_page = '''<html><head>
<meta property="og:title" content="北京一日游路线分享">
<meta property="og:description" content="上午天安门看升旗，故宫，下午景山公园看故宫全景，晚上王府井吃小吃">
</head></html>'''
result2 = fetch_douyin(dy_page)
print("\n抖音提取结果：")
print(result2)
assert result2 and "天安门" in result2
print("\n[通过] 抖音og标签提取正常")
