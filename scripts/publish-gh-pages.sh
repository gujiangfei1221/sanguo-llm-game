#!/usr/bin/env bash
# 构建前端并发布到 gh-pages 分支（GitHub Pages 站点根）
# 用法：./scripts/publish-gh-pages.sh
# 家庭服务器上配合 cron 定时执行即可自动发布最新战报。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BRANCH="gh-pages"
WORKTREE="${PUBLISH_WORKTREE:-$ROOT/.publish}"

# 1. 构建前端（GH_PAGES=1 → Vite base=/sanguo-llm-game/，replays 已随 public 进入产物）
GH_PAGES=1 npm run build -w @sanguo/web

# 2. 准备 gh-pages 分支工作树（始终以 origin/gh-pages 为基线，避免历史分叉）
if [ ! -e "$WORKTREE/.git" ]; then
  git worktree add --detach "$WORKTREE"
fi
if git rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
  git -C "$WORKTREE" checkout -B "$BRANCH" origin/gh-pages
elif git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git -C "$WORKTREE" checkout "$BRANCH"
else
  git -C "$WORKTREE" checkout -B "$BRANCH"
fi

# 3. 清空并拷贝构建产物（含 replays/；保留 .git 工作树指针）
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R apps/web/dist/* "$WORKTREE"/

# 4. 提交并推送
git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "[publish] 无内容变更，跳过推送"
else
  git -C "$WORKTREE" -c user.name="sanguo-bot" -c user.email="sanguo-bot@users.noreply.github.com" \
    commit -m "publish: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git -C "$WORKTREE" push origin "$BRANCH"
  echo "[publish] 已推送 $BRANCH"
fi
