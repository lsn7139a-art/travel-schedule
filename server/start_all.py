# -*- coding: utf-8 -*-
"""静默启动全部服务：静态页面(7777) + 抓取服务(7778) + Ollama(11434)"""
import subprocess
import sys
import time
import urllib.request

FLAGS = 0x08000000  # CREATE_NO_WINDOW：无终端窗口
CWD = r"d:\程序\旅游规划"

subprocess.Popen([sys.executable, "-m", "http.server", "7777", "--bind", "127.0.0.1"],
                 cwd=CWD, creationflags=FLAGS)
subprocess.Popen([sys.executable, "server\\fetch_server.py"],
                 cwd=CWD, creationflags=FLAGS)
subprocess.Popen(["ollama", "serve"], creationflags=FLAGS)

for name, url in [("7777", "http://127.0.0.1:7777/"),
                  ("7778", "http://127.0.0.1:7778/"),
                  ("11434", "http://127.0.0.1:11434/api/tags")]:
    ok = False
    for i in range(20):
        time.sleep(1.5)
        try:
            urllib.request.urlopen(url, timeout=4)
            ok = True
            break
        except Exception:
            pass
    print(name, "UP" if ok else "TIMEOUT")
