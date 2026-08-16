#!/usr/bin/env bash
# 启动三国自动对局服务器（幂等：已在运行则跳过）
cd ~/sanguo || exit 1
# 注意：pgrep 用 [a]pps 前缀避免匹配到调用本脚本的 shell 命令行（自匹配坑）
if pgrep -f '[a]pps/server/src/index.ts' >/dev/null 2>&1; then
  exit 0
fi
nohup ./node_modules/.bin/tsx apps/server/src/index.ts >> /tmp/sanguo-server.log 2>&1 &
echo "$(date '+%F %T') server started" >> /tmp/sanguo-server.log
