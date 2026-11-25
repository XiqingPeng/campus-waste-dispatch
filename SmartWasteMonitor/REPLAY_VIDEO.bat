@echo off
setlocal
if not "%~1"=="" goto run
echo Drag a local video onto REPLAY_VIDEO.bat, or paste a file path.
set "VIDEO="
set /p "VIDEO=Video path: "
if not defined VIDEO exit /b 1
set "VIDEO=%VIDEO:"=%"
call "%~dp0START_WINDOWS.bat" --video "%VIDEO%"
exit /b %errorlevel%

:run
call "%~dp0START_WINDOWS.bat" --video "%~1"
