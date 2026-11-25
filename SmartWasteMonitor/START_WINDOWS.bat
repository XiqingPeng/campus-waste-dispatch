@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "PYTHONUTF8=1"
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" goto install
if not exist ".runtime\ready" goto install
if not exist "weights\hand_landmarker.task" goto install
goto run

:install
call INSTALL_WINDOWS.bat --quiet
if errorlevel 1 goto fail

:run
".venv\Scripts\python.exe" run.py %*
if errorlevel 1 goto fail
popd
exit /b 0

:fail
echo The monitor could not start. Read the message above or README.md.
popd
pause
exit /b 1
