@echo off
rem ============================================
rem  旅行攻略地图 - 一键启动
rem  1. 结束旧的服务进程(占用7777/7778端口)
rem  2. 后台静默启动：静态页面服务 + 链接抓取服务
rem  3. 自动打开浏览器
rem ============================================
cd /d "%~dp0"

rem 结束占用端口的旧进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7778" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

rem 选择可用的 Python 命令
set "PYCMD=python"
where python >nul 2>nul || set "PYCMD=py"

rem 静默后台启动静态页面服务(7777)
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '%PYCMD%' -ArgumentList '-m','http.server','7777','--bind','127.0.0.1' -WorkingDirectory '%~dp0.'"

rem 静默后台启动链接抓取服务(7778)
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '%PYCMD%' -ArgumentList 'server\fetch_server.py' -WorkingDirectory '%~dp0.'"

rem 等待服务就绪后打开浏览器
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:7777"
