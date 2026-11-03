@echo off
title Clean Cinema - Local Server
echo.
echo  ========================================
echo   Clean Cinema - Локальный запуск
echo  ========================================
echo.

:: Проверка виртуального окружения
if not exist "venv\Scripts\activate.bat" (
    echo [*] Создаю виртуальное окружение...
    python -m venv venv
)

:: Активация
call venv\Scripts\activate.bat

:: Установка зависимостей
echo [*] Устанавливаю зависимости...
pip install -r requirements.txt -q

:: Определение IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set LOCAL_IP=%%b
)

echo.
echo  ========================================
echo   Сервер запущен!
echo  ========================================
echo.
echo   На этом ПК:     http://localhost:8000
echo   С телефона:      http://%LOCAL_IP%:8000
echo.
echo   Нажми Ctrl+C для остановки.
echo  ========================================
echo.

:: Запуск сервера
uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
