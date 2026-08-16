# 三国大模型回合游戏整体实现方案

## 1. 总体方案

- 构建本机单用户 Web 应用，绑定 `127.0.0.1`，不做登录和公网部署。
- 使用全栈 TypeScript：React/Vite + Fastify + SQLite + npm workspaces。
- 第一版统一通过 `pi -p --provider ark-coding --model` 调用 Coding Plan 中的不同模型，不直接请求模型 API。
- 游戏引擎保持纯函数；Pi CLI 仅存在于独立 Harness 层，未来可替换其他 CLI。
- 多个模型默认并发执行，并且都读取同一回合快照，因此不会看到其他势力本回合尚未公开的命令。

## 2. 系统架构

### 2.1 模块划分

```text
apps/web                 创建对局、观看回合、人工操作
apps/server              API、SSE、回合状态机、Pi 进程调度
packages/shared          Zod Schema、公共类型、API 协议
packages/game-engine     纯规则校验、收入、战争、外交、胜负
packages/pi-harness      Pi CLI 调用、超时、解析、隔离
config/models.json       Coding Plan 模型白名单
scenarios/basic.json     第一版固定三国剧本
```

### 2.2 核心边界

```text
prepareTurn(oldState)
→ preparedState + preparationEvents

resolveTurn(preparedState, lockedOrders)
→ newState + publicEvents + victoryResult
```

`game-engine` 不允许依赖数据库、HTTP、Pi CLI、文件系统或当前时间。

## 3. 状态与持久化

### 3.1 SQLite 数据

- `games`：配置、当前状态 JSON、当前阶段、自动播放设置和版本号。
- `turns`：回合前状态、准备后状态、结算后状态及优先级。
- `turn_orders`：模型或玩家提交的结构化命令、校验状态和公开理由。
- `faction_memories`：各势力私有战略摘要，按 `game_id + faction_id` 隔离。
- `harness_runs`：模型、耗时、退出码、错误类型和重试次数，不默认保存原始输出。
- `game_events`：供时间线、SSE 和复盘使用的公开事件。

SQLite 开启 WAL；允许保存多局游戏，但同一时间只执行一局，避免多个 Pi 进程争抢套餐额度。

### 3.2 回合状态机

```text
DRAFT
→ WAITING_TO_ADVANCE
→ PREPARING
→ COLLECTING_ORDERS
→ ORDERS_LOCKED
→ RESOLVING
→ PUBLISHING
→ WAITING_TO_ADVANCE / FINISHED
```

技术调用失败后进入 `BLOCKED`，自动播放暂停。玩家可以重试该势力、切换模型或强制休整。

服务重启时：

- 已结算回合不会重复执行。
- `THINKING` 中的进程视为中断并进入 `BLOCKED`。
- 从 SQLite 中的持久化阶段恢复，不从内存猜测状态。

## 4. Pi Harness

### 4.1 调用方式

使用 `child_process.spawn`，禁止拼接 Shell 字符串：

```text
pi -p
  --mode json
  --provider ark-coding
  --model <白名单模型>
  --no-tools
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-context-files
  --no-session
  --no-approve
  --system-prompt <角色与规则提示词>
```

观察信息通过 stdin 输入；每次调用运行在独立空临时目录，不允许访问项目目录。

### 4.2 配置与安全

- Pi 直接复用本机 `ark-coding` Provider 的现有鉴权配置，应用不读取或保存 API Key。
- 模型只能从 `config/models.json` 选择，模型 ID 不允许网页自由输入。
- 子进程环境采用白名单，仅保留必要的 `PATH`、`HOME`、代理和 Anthropic 配置。
- 不加载扩展、技能、项目上下文和 Pi 持久会话。
- stdout 上限 1 MiB、stderr 上限 256 KiB，默认单次超时 90 秒、低思考强度、失败后由玩家选择重试或休整。

### 4.3 失败策略

- 进程异常、超时或结构化输出解析失败时进入 `BLOCKED`，避免自动重试导致等待时间翻倍。
- 模型成功输出但游戏命令非法时不重试，按游戏规则转为休整。
- 第一阶段先完成 Harness 合约测试，按 Pi JSONL 中 assistant `message_end` 的文本块解析最终决策。

## 5. 模型输入与输出

### 5.1 每回合输入

- 固定角色设定和简化规则。
- 当前完整局势、合法行动及参数范围。
- 最近 3 回合公开事件。
- 当前外交关系及收到的消息。
- 该势力上一回合的私有战略摘要。
- 外交内容明确标记为不可信游戏文本。

不复用 Pi session，长期连续性由应用保存的私有摘要提供。

### 5.2 结构化输出

```ts
interface ModelDecision {
  action: MainAction;
  diplomacy: {
    responses: Array<{
      proposalId: string;
      decision: "accept" | "reject";
    }>;
    initiative?: {
      type: "message" | "propose_alliance" | "break_alliance";
      targetFactionId: string;
      message?: string;
    };
  };
  publicMessage: string;
  reasonSummary: string;
  privateMemory: string;
}
```

限制：

- `publicMessage` 最长 300 字。
- `reasonSummary` 最长 500 字，公开展示，不要求思维链。
- `privateMemory` 最长 1500 字，仅本势力下回合可见，游戏结束后统一揭示。

## 6. Web 与 API

### 6.1 页面

- 首页：新建对局、选择三个模型、指定人工势力、继续历史对局。
- 对局页：回合阶段、势力资源、城池文字关系、模型思考状态、回合事件时间线。
- 操作区：下一回合、自动播放、暂停、人工命令、接管或交还势力。
- 异常区：显示 Harness 错误，并提供重试、换模型和强制休整。

人工操作使用根据合法行动生成的表单，不要求玩家填写 JSON。

### 6.2 API

- `GET /api/config/models`
- `POST /api/games`
- `GET /api/games/:gameId`
- `POST /api/games/:gameId/start`
- `POST /api/games/:gameId/advance`
- `POST /api/games/:gameId/auto-play`
- `POST /api/games/:gameId/pause`
- `POST /api/games/:gameId/orders`
- `POST /api/games/:gameId/factions/:factionId/controller`
- `POST /api/games/:gameId/turns/:turn/retry/:factionId`
- `POST /api/games/:gameId/turns/:turn/force-rest/:factionId`
- `GET /api/games/:gameId/events`：SSE
- `GET /api/games/:gameId/replay`

玩家只能在两个回合之间接管或交还势力。模型命令全部完成并锁定前，不向玩家展示任何势力的本回合决策。

自动播放每轮发布后等待 1 秒继续；遇到人工势力、暂停、技术错误或游戏结束立即停止。

## 7. 测试方案

- 规则单测：资源非负、征兵上限、粮草维持、城防、占领、外交和胜负条件。
- 确定性测试：相同状态和命令必须得到完全相同的新状态及事件。
- 属性测试：任何合法命令组合都不能产生负资源、重复城池所有权或重复结算。
- 状态机集成测试：正常回合、人工等待、模型超时、重试、强制休整和服务重启恢复。
- Harness 测试：参数无 Shell 注入、模型白名单、工具关闭、超时杀进程、输出大小限制。
- Web 测试：创建三势力对局、完成一轮、自动播放、暂停、接管、恢复和局末记忆揭示。
- 真实 Pi 合约测试单独运行，默认测试套件使用 Fake Harness，避免消耗 Coding Plan 额度。

## 8. 实施顺序

1. 建立 npm workspace、公共 Schema、基础剧本和程序设计文档。
2. 实现纯 `game-engine` 及规则测试。
3. 实现 SQLite、回合状态机和崩溃恢复。
4. 实现 Pi Harness、模型白名单及真实合约测试。
5. 实现 Fastify API、SSE 和自动播放调度。
6. 实现 React 文本界面与人工操作表单。
7. 完成端到端对局、规则平衡检查和 README 使用说明。

## 9. 第一版默认约束

- 第一版仅供用户本人在本机运行，用户接受使用现有 Coding Plan 的相关限制与风险。
- 首局固定为魏、蜀、吴三个势力和基础剧本，不提供地图或剧本编辑器。
- 默认 30 回合、完全信息、无随机战争结算。
- Pi CLI 是第一版唯一 Harness；其他 CLI 只保留接口，不在第一版实现。
- 模型调用默认最多并发 3 个，所有模型仍基于同一冻结快照决策。
