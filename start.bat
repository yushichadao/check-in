@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   班级签到系统 - 本地启动
echo   本机访问：  http://localhost:3000/check-in/
echo   手机访问：  http://本机IP:3000/check-in/  (同一 WiFi)
echo   关闭本窗口即停止服务
echo ============================================
echo.
node server/index.js
echo.
echo 服务已停止（按任意键关闭窗口）
pause >nul
