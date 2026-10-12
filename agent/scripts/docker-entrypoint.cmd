@echo off

CALL git --version
CALL node --version
CALL dotnet --version
CALL docker --version

echo "%USERPROFILE%"
md "%USERPROFILE%\.ssh"
copy C:\secrets\id* "%USERPROFILE%\.ssh"
dir "%USERPROFILE%\.ssh"

call C:\buildkite-agent\bin\buildkite-agent.exe start
