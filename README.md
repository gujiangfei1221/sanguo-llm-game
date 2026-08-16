# 三国大模型回合战

一个本机运行的文本回合制三国游戏。魏、蜀、吴可分别绑定方舟 Coding Plan 中的不同模型，由本地 `pi` CLI 进行决策；玩家也可以接管任意一方。

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
