@echo off
SET MB_ARGS=%~1 %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
ECHO "[MB] maker-%MB_ARGS%"
SET NPM_PATH=%APPDATA%\npm
SET PATH=C:\Program Files\Git\usr\bin;C:\Program Files\nodejs;%NPM_PATH%\npm;%PATH%
SET MB_SRC=%cd%\src\maker-builder
SET NPM_AUTH_TOKEN=

if exist "%MB_SRC%" (
  ECHO "[MB] remove old installation..."
  CALL npm uninstall -g "@openworkshop/maker-builder"

  ECHO "[MB] install dependencies in %MB_SRC%..."
  CD "%MB_SRC%"
  CALL yarn install

  CD "..\..\"
  ECHO %cd% | clip
  ECHO "[MB] install new package..."
  CALL npm install -g --force "%MB_SRC%"

  ECHO "[MB] verify installation..."
  CALL npm cache verify
  SET MB_INSTALLED=true
  SET MB_LOCAL=true
) else (
  ECHO "[MB] install global package..."
  CALL npm install -g "@openworkshop/maker-builder@latest"
  SET MB_INSTALLED=true
  SET MB_LOCAL=false
)

ECHO "[MB] check maker versions..."
CALL "%NPM_PATH%\\maker-env" "--version"
CALL "%NPM_PATH%\\maker-env" "prep"

ECHO "[MB] run npx maker-%MB_ARGS%"
CALL npx maker-%MB_ARGS%"
if NOT "%ERRORLEVEL%" == "0" exit /B %ERRORLEVEL%
