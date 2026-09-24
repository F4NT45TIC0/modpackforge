@echo off
chcp 65001 >nul
title ModpackForge
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 goto semnode
node server.mjs
if errorlevel 1 pause
exit /b
:semnode
echo.
echo   O ModpackForge precisa do Node.js para rodar.
echo   Baixe a versao LTS em https://nodejs.org e abra este arquivo de novo.
echo.
pause
exit /b 1
