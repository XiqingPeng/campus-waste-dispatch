@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "PYTHONUTF8=1"
set "PIP_CONFIG_FILE=NUL"
set "PIP_NO_INDEX=1"
set "PIP_NO_INPUT=1"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "PIP_REQUIRE_VIRTUALENV=1"

if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto supported
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto supported
echo This package targets Windows 10 or 11 on x64 Intel or AMD processors.
goto fail

:supported
if not exist "vendor\python\python.exe" goto files_missing
if not exist "vendor\wheels" goto files_missing
if not exist "weights\hand_landmarker.task" goto files_missing
if not exist ".runtime" mkdir ".runtime" || goto fail
if exist ".runtime\ready" del /q ".runtime\ready"
echo Setting up the bundled offline Python runtime and packages.
if exist ".venv\Scripts\python.exe" goto dependencies
"vendor\python\python.exe" -m venv --copies ".venv" || goto fail

:dependencies
".venv\Scripts\python.exe" -m pip --isolated install --no-index --find-links "vendor\wheels" --no-cache-dir --disable-pip-version-check --only-binary=:all: --require-hashes -r requirements-windows.txt || goto fail
".venv\Scripts\python.exe" tools\check_install.py || goto fail
echo ready>".runtime\ready"
echo Installation complete. Use START_WINDOWS.bat or DEMO_NO_CAMERA.bat.
popd
if /I not "%~1"=="--quiet" pause
exit /b 0

:files_missing
echo Some bundled files are missing. Extract the complete archive before starting.

:fail
echo Installation did not complete. Check the preceding error and retry.
echo If an OpenCV DLL is missing, see README.md for the Windows runtime link.
popd
if /I not "%~1"=="--quiet" pause
exit /b 1
