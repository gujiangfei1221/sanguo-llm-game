# 大模型血战三国

一个本机运行的文本回合制三国游戏。魏、蜀、吴可分别绑定方舟 Coding Plan 中的不同模型，由本地 `pi` CLI 进行决策；玩家也可以接管任意一方。

支持**全自动轮换 + GitHub Pages 直播/回放**：在家里的服务器上让三方真模型自动对局，一局结束自动开下一局，并把实时快照与完整战报发布到 GitHub Pages，访客无需后端即可围观。

当前规则已升级到 V2.0：

- 1～8 回合蓄势、9～18 回合争锋、19 回合起决战。
- 九城对称剧本，城市只能选择商贸、农桑、军镇之一。
- 资源库存上限、扩张行政成本和阶段递增的军队维持费。
- 低兵力时的决战强征、战后增援、持续围城、限次背水一战和残余势力崩溃归降。
- 旧存档读取时自动补齐 V2.0 状态字段，新建对局使用完整 V2.0 剧本。

## 环境要求

- Node.js 22 或更高版本。
- 已安装 `pi`，当前开发环境验证版本为 `0.84.1`。
- `pi auth check --provider ark-coding --no-refresh` 返回 ready。

可用模型可以通过以下命令确认：

```bash
pi --list-models | grep ark-coding
```

模型白名单位于 `config/models.json`。

## 启动

```bash
npm install
cp .env.example .env.local
npm run dev
```

访问 `http://127.0.0.1:5173`。

默认使用真实 Pi Harness：

```env
HARNESS_MODE=pi
PI_PROVIDER=ark-coding
PI_THINKING=low
PI_TIMEOUT_MS=180000
MODEL_CONCURRENCY=3
```

如果只想测试规则和页面，不消耗 Coding Plan 额度：

```env
HARNESS_MODE=fake
```

## 构建运行

```bash
npm run build
npm start
```

访问 `http://127.0.0.1:3000`。数据保存在 `data/sanguo.db`。

## 全自动轮换（家庭服务器）

后端增加 `AUTO_ROTATE` 开关：

```bash
AUTO_ROTATE=1 npm start
```

开启后：

- 启动时若没有进行中的对局，自动按 `config/auto-rotate.json` 创建一局（魏/蜀/吴全部由真实模型控制）并开始推演。
- 对局结束后自动按同一配置开下一局（局名追加 `#N`），7×24 循环不断。
- 所有对局按原样记录在 `data/sanguo.db`，真实模型决策，无人工介入。

## 直播快照与回放导出

- 运行中每 30 秒自动把**当前进行中对局**导出为 `apps/web/public/replays/live.json`（近实时快照）。
- 对局**结束后自动导出**完整回放 `replays/<gameId>.json` 并维护 `replays/index.json` 战报清单。
- 历史回放默认保留最近 50 局（`REPLAY_KEEP_MAX` 可调），超龄文件自动清理。
- 也可手动全量重导：

```bash
npm run export -w @sanguo/server
```

## 部署到 GitHub Pages

1. 建好 GitHub 仓库，初始化并推送 `main`：

```bash
git init -b main
git add -A && git commit -m "init"
git remote add origin <仓库地址>
git push -u origin main
```

2. 构建并发布到 `gh-pages` 分支（站点静态根 = 分支根，含 `replays/`）：

```bash
./scripts/publish-gh-pages.sh
```

   脚本会用 `GH_PAGES=1` 构建（Vite `base=/仓库名/`），把产物推送到 `gh-pages` 分支。

3. 开启 Pages：仓库 **Settings → Pages → Source: Deploy from a branch → `gh-pages` / root**。

   站点地址为 `https://<用户名>.github.io/<仓库名>/`。

4. 前端会自动探测运行模式：能访问 `/api` 时是交互版；纯静态托管时自动切换为**直播/回放只读模式**（首页列直播局与战报、`#live` 看直播、`#replay=<id>` 看回放，可拖进度条）。

### 家庭服务器自动发布

发布脚本会重建站点并推送 `gh-pages`，内容有变化才推送。配合 cron 即可自动发布最新战报：

```bash
# 每 5 分钟发布一次
*/5 * * * * cd /path/to/sanguo && ./scripts/publish-gh-pages.sh >> /tmp/sanguo-publish.log 2>&1
```

注意：家庭服务器只需**出站**推送 GitHub，无需内网穿透/公网 IP；访客访问的是 GitHub Pages。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

默认测试使用 Fake Harness，不会调用真实模型。

## 文档

- 游戏规则：`GAME_DESIGN.md`
- 程序设计：`PROGRAM_DESIGN.md`
