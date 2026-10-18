@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   正在启动博客编辑器，浏览器会自动打开...
echo   写完文章关掉这个窗口就退出了。
echo.
pnpm blog
echo.
echo   编辑器已退出。如果报错，往上翻看日志。
pause >nul
