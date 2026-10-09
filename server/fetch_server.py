# -*- coding: utf-8 -*-
"""本地抓取服务：小红书 / 抖音 / 普通网页 → 纯文本攻略
纯标准库实现，无第三方依赖。端口 7778，接口：GET /fetch?url=...
返回 {"ok":true,"source":"小红书|抖音|网页","text":"..."}
"""
import json
import os
import re
import time
import subprocess
import html as html_lib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen

PORT = 7778
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")


def http_get(url, timeout=15):
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    })
    with urlopen(req, timeout=timeout) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        # geturl() 返回跳转后的最终地址（短链 → 实际站点）
        return r.geturl(), r.read().decode(charset, errors="replace")


def meta_og(page, name):
    """提取 og:xxx 等 meta 标签内容（属性顺序两种写法都兼容）"""
    patterns = [
        r'<meta[^>]+(?:property|name)=["\']' + re.escape(name) + r'["\'][^>]+content=["\']([^"\']*)["\']',
        r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + re.escape(name) + r'["\']',
    ]
    for p in patterns:
        m = re.search(p, page, re.I)
        if m:
            return html_lib.unescape(m.group(1)).strip()
    return ""


def strip_html(page):
    page = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", page, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", page)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t\r\f]+", " ", text)
    lines = [l.strip() for l in text.split("\n")]
    return "\n".join(l for l in lines if l)


def clean_text(text):
    """去掉App引导等噪音（含行内重复）与连续重复行"""
    text = re.sub(r"打开App查看更多|点击查看更多|加载更多", " ", text)
    text = re.sub(r"\b\d+/\d+\b", " ", text)  # 图片页码 1/12
    junk = re.compile(r"^(点击查看|展开.*|收起.*|\d+条评论.*)$")
    out, prev = [], None
    for line in text.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if not line or junk.match(line) or line == prev:
            continue
        out.append(line)
        prev = line
    return "\n".join(out)


def fetch_xhs(page):
    """小红书笔记：og:description 通常含完整正文，SSR desc 兜底"""
    title = meta_og(page, "og:title")
    desc = meta_og(page, "og:description")
    m = re.search(r'"desc"\s*:\s*"((?:[^"\\]|\\.)*)"', page)
    if m:
        try:
            full = json.loads('"' + m.group(1) + '"')
        except Exception:
            full = ""
        if len(full) > len(desc):
            desc = full
    text = (title + "\n" + desc).strip()
    return text if len(text) > 20 else None


def fetch_douyin(page):
    """抖音分享页：提取标题与文案描述（视频语音转文字暂不支持）"""
    title = meta_og(page, "og:title")
    desc = meta_og(page, "og:description")
    if not title:
        m = re.search(r"<title>([^<]*)</title>", page, re.I)
        title = html_lib.unescape(m.group(1)).strip() if m else ""
    text = (title + "\n" + desc).strip()
    return text if len(text) > 20 else None


# ---------------- 抖音视频：下载原声 → FunASR 本地转写 ----------------

UA_PC = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
ASR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr")
ASR_EXE = os.path.join(ASR_DIR, "bin", "llama-funasr-sensevoice.exe")
ASR_MODEL = os.path.join(ASR_DIR, "models", "sensevoice-small-f16.gguf")
ASR_VAD = os.path.join(ASR_DIR, "models", "fsmn-vad.gguf")
TTWID_FILE = os.path.join(ASR_DIR, "ttwid.txt")       # 缓存访客 cookie
ASR_CACHE_DIR = os.path.join(ASR_DIR, "cache")         # 转写结果缓存（按视频ID）


def asr_ready():
    return all(os.path.exists(p) for p in (ASR_EXE, ASR_MODEL, ASR_VAD))


def get_ttwid(force=False):
    """获取（并缓存）抖音访客 ttwid，无需登录"""
    if not force:
        try:
            with open(TTWID_FILE, encoding="utf-8") as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            pass
    body = json.dumps({
        "region": "cn", "aid": 6383, "needFid": False, "service": "www.douyin.com",
        "migrate_info": {"ticket": "", "source": "node"},
        "cbUrlProtocol": "https", "union": True
    }).encode()
    req = Request("https://ttwid.bytedance.com/ttwid/union/register/", data=body,
                  headers={"Content-Type": "application/json", "User-Agent": UA_PC})
    with urlopen(req, timeout=15) as r:
        m = re.search(r"ttwid=([^;]+)", (r.headers.get_all("Set-Cookie") or [""])[0])
        if not m:
            raise RuntimeError("ttwid 获取失败")
        val = m.group(1)
    os.makedirs(ASR_DIR, exist_ok=True)
    with open(TTWID_FILE, "w", encoding="utf-8") as f:
        f.write(val)
    return val


def douyin_detail(video_id, ttwid):
    req = Request(f"https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id={video_id}",
                  headers={"User-Agent": UA_PC, "Referer": "https://www.douyin.com/",
                           "Cookie": f"ttwid={ttwid}"})
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8", "replace")).get("aweme_detail") or {}


def transcribe_audio(mp3_path):
    """FunASR SenseVoice 本地转写（纯二进制，无 Python 依赖）
    注意：exe 的 C 运行时对中文 argv 转码有兼容问题，因此 cwd 设为 asr 目录、
    参数全部用相对路径（纯 ASCII），exe 绝对路径由 Windows API 处理不受影响。"""
    rel = lambda p: os.path.relpath(p, ASR_DIR)
    p = subprocess.run(
        [ASR_EXE, "-m", rel(ASR_MODEL), "--vad", rel(ASR_VAD), "-a", rel(mp3_path)],
        capture_output=True, timeout=900, cwd=ASR_DIR)
    if p.returncode != 0:
        raise RuntimeError("语音转写失败：" + p.stderr.decode("utf-8", "replace")[:200])
    return p.stdout.decode("utf-8", "replace").strip()


def fetch_douyin_video(final_url):
    """抖音视频：文案 + 原声语音转写。返回 (text, src) 或抛异常"""
    m = re.search(r"/video/(\d+)", final_url)
    if not m:
        raise RuntimeError("无法从抖音链接解析视频ID")
    video_id = m.group(1)

    # 1) 拿视频详情（ttwid 失效/风控 403 时换新 cookie 重试）
    detail = {}
    last_err = None
    for attempt in range(3):
        try:
            detail = douyin_detail(video_id, get_ttwid(force=attempt > 0))
            if detail:
                break
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    if not detail:
        raise RuntimeError(f"抖音视频信息获取失败：{last_err or '无数据'}")

    caption = (detail.get("caption") or detail.get("desc") or "").strip()
    duration_ms = (detail.get("video") or {}).get("duration") or 0

    # 2) 下载原声（mp3）→ 转写（结果按视频ID缓存）
    os.makedirs(ASR_CACHE_DIR, exist_ok=True)
    cache = os.path.join(ASR_CACHE_DIR, f"{video_id}.txt")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            transcript = f.read().strip()
    else:
        music_urls = ((detail.get("music") or {}).get("play_url") or {}).get("url_list") or []
        if not music_urls:
            raise RuntimeError("视频没有可用的原声音频")
        req = Request(music_urls[0], headers={"User-Agent": UA_PC, "Referer": "https://www.douyin.com/"})
        with urlopen(req, timeout=120) as r:
            audio = r.read()
        if len(audio) < 4096:
            raise RuntimeError("原声下载失败")
        tmp_mp3 = os.path.join(ASR_CACHE_DIR, f"{video_id}.mp3")
        with open(tmp_mp3, "wb") as f:
            f.write(audio)
        try:
            transcript = transcribe_audio(tmp_mp3)
        finally:
            try:
                os.remove(tmp_mp3)
            except OSError:
                pass
        with open(cache, "w", encoding="utf-8") as f:
            f.write(transcript)

    parts = []
    if transcript:
        parts.append("【视频语音内容】\n" + transcript)
    if caption:
        parts.append("【视频文案】\n" + caption)
    text = "\n\n".join(parts)
    if len(text) < 30:
        raise RuntimeError("视频没有解析出可用内容")
    return text, "抖音视频"


def fetch_generic(page):
    m = re.search(r"<title>([^<]*)</title>", page, re.I)
    title = html_lib.unescape(m.group(1)).strip() if m else ""
    body = strip_html(page)
    return (title + "\n" + body).strip()[:8000]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 静默运行
        pass

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if not self.path.startswith("/fetch"):
            return self._send({"ok": True, "service": "fetch", "port": PORT})
        q = parse_qs(urlparse(self.path).query)
        url = (q.get("url") or [""])[0]
        if not url.startswith(("http://", "https://")):
            return self._send({"ok": False, "error": "无效链接"}, 400)
        host = ""
        page = ""
        try:
            final_url, page = http_get(url)
            host = urlparse(final_url).netloc.lower()
        except Exception as e:
            return self._send({"ok": False, "error": f"抓取失败：{e}"}, 502)
        try:
            if "xiaohongshu.com" in host:
                # og/SSR 提取 与 正文提取 取更完整的一份
                structured = fetch_xhs(page) or ""
                body = clean_text(strip_html(page))
                text, src = (structured if len(structured) >= len(body) else body), "小红书"
            elif "douyin.com" in host:
                # 视频链接（含 /video/ 或 /share/video/）→ 原声转写；图集/其他 → 页面文案
                if re.search(r"/video/\d+", final_url) and asr_ready():
                    text, src = fetch_douyin_video(final_url)
                else:
                    text, src = fetch_douyin(page), "抖音"
            else:
                text, src = clean_text(fetch_generic(page)), "网页"
            if not text:
                return self._send({
                    "ok": False,
                    "error": f"{src}页面未解析出文字（可能需要登录或为视频内容），请手动复制攻略文字"
                }, 422)
            return self._send({"ok": True, "source": src, "text": text})
        except Exception as e:
            return self._send({"ok": False, "error": f"解析失败：{e}"}, 500)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

