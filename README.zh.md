# dsh-shell-boot-timeout

[English](README.md) | 中文

一个**很小、单文件**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。

它只做一件事：挂**一个** `tools/execute` 监听器，给 shell 工具的首次调用加上时限。这样当持久
shell 迟迟启动不起来时，会返回一条明确的错误，而不是一直静默空转、直到后端自己的 300 秒超时。

刻意做得很小：**零依赖**、一个源文件、profile patch 里只插入一行。它不修改任何随发行版分发的
包，也不改动任何预设。

---

## 适用版本范围

**安装前请先看这一节。** 这是一个绑定上游具体行为的绕行方案，版本很关键。

| | 版本 |
|---|---|
| **已验证** | `@deepseek-ai/dsh` **0.2.0-rc.2** |
| **声明范围**（`package.json` → `dsh.supported`） | `>=0.2.0-rc.2 <0.3.0` |
| **已验证平台** | **仅 Windows** |
| **未测试** | `0.1.x`、`0.3.x`、macOS、Linux |

声明范围是**预期**，不是保证——它所依赖的行为只在 `0.2.0-rc.2` 上复现过。版本检查是**软性**的：
遇到未验证的版本只记一条警告并继续工作，不会让你的 profile 启动失败。

**它依赖什么**，也就意味着上游哪些改动可能让它失效：

- Cordis 的 `tools/execute` 瀑布（模式、顺序、替换 signal 的规则）；
- `defineTool` 把 `parameters` 归一化成带 `properties` 的 JSON Schema；
- 两个随发行版分发的 shell 工具的**参数形态**（见下文《它如何判断该不该限时》）。

如果将来某个版本改动了其中任何一项，插件的表现是**退回不限时**——它的握手判断会返回 `false`，
而不是在一个本来正常的模式里制造出新的失败。

---

## 它解决什么问题

**极简模式**下的 shell 工具是 `@deepseek-ai/dsh-tool-pwsh-persistent`，它通过一个**持久 PTY 会话**
执行命令。它的首次调用必须先启动 shell 并等到 *readiness*（就绪）。

`dsh-terminal-bash` 会装入一个 PowerShell `prompt` 函数，用来发出 OSC `133;D;` 标记，并且
**只**接受 `waitReason === 'stdin_read'` 作为 shell 已就绪的凭据：

```js
"function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); 'dsh> ' }"
```

在 Windows 上，当会话运行在 ACL 沙箱的 **`read-only`** 模式时，pwsh 会以
**ConstrainedLanguage** 启动（它写 AppLocker 探针临时文件被拒）。此时 `[Console]::Write` 报错：

```
InvalidOperation: Cannot create type. Only core types are supported in this language mode.
```

于是那个标记**永远不会发出**。而 Windows 的进程检查器 `isStdinWaiting()` 恒返回 `false`，导致该
标记成为通往 `stdin_read` 的**唯一**路径；启动循环又忽略 `inferred_idle` 兜底，于是不停重发。
从头到尾没有任何命令被执行，所以也没有任何东西会失败——调用就一直挂着。

触发条件必须是：**极简模式 + `read-only` 沙箱**。其它模式用一次性 `pwsh` 工具，不需要启动握手，
在任何权限模式下都正常。

---

## 它做什么、不做什么

**做**：把静默空转变成一条快速的结构化错误：

```
Error: the shell behind the `pwsh` tool never reported readiness within 20000ms, so no
command was run. ... Switch the permission preset to `workspace-write` ...
```

它会**先 abort** 再返回：abort 会解除挂起的 PTY spawn，所以被放弃的调用会真的停下来，而不是继续
跑到后端的截止时间。

**不做**：它**不会**让 `pwsh` 在「极简 + 只读」下变得可用。这个空转是上游的引导缺陷，profile
插件无法修复；本插件只是让失败变得快速且可自我解释。

### 它如何判断该不该限时

限时**绝不能**作用到标准 / PTC / 创造模式——那里用的是**一次性** `pwsh`，它的**首次**调用就已经
是一条真实命令（`npm install`、跑测试套件），完全可能超过任何固定预算。两者靠**声明的参数**区分：

| 工具 | 模式 | 声明的参数 | 是否限时 |
|---|---|---|---|
| `@deepseek-ai/dsh-tool-pwsh` | standard、ptc、cordis | `command`、`description`、`timeoutMs`、`workdir` | **否** |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | minimal | 仅 `command` | **是** |

一个接受自己的**每条命令** `timeoutMs` 的工具，说明它立即执行真实命令、已经由调用方限时，因此不
干预。**读不到或无法识别的 schema 同样按「不限时」处理。**

### 重试安全

被限时失败的调用**不会**把 shell 标记为已启动，所以**重试仍会被限时**，不会悄悄退回 300 秒空转。
真正启动成功之后，该 Agent 的限时才会解除，从而让长时间命令保留它们原有的预算。

---

## 安装

本插件是一个 DSH **bundle**：`package.json` 里声明了 `dsh.bundle.patch` 的包。用插件管理器安装
（`install_bundle`，传入本目录），包安装与 bundle 选择由它自己完成。

> **包名与仓库名不同。** 包名是 `@local/dsh-shell-boot-timeout`，而仓库名取自 patch 行的 id
> （`shell-boot-timeout`）。该包是 `private: true`、从不会发布到 npm——`@local/` 只是「仅本地」
> bundle 的命名惯例，所以这个名字只对 DSH 的模块解析有意义。

> **需要 pnpm ≥ 10。** DSH 的 profile 脚手架从 `pnpm-workspace.yaml` 读取 pnpm 设置，而只有
> pnpm ≥ 10 才会读那里；pnpm 9 会以 `ERR_PNPM_ADDING_TO_ROOT` 失败。这是环境要求，与本插件无关。

修改模块文件后必须**重启宿主**才会生效：Node 的 ESM 加载器会缓存已导入的模块，所以把该行关掉再
打开仍会复用旧代码。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bootTimeoutMs` | `20000` | 首次 shell 工具调用的预算。宿主很慢时可调大。 |
| `toolNames` | `['pwsh', 'bash']` | 有资格被限时的工具名；仍会经过握手判断。 |
| `verifiedDshVersion` | `0.2.0-rc.2` | 已验证的下界；低于它只记一条警告。 |

配置非法会在激活时抛错（`bootTimeoutMs` 非正，或 `toolNames` 为空）。

## 测试

两套测试都只需普通 Node 运行——不启动 DSH、不联网：

```sh
node tests/offline.test.mjs        # 12 项：超时、透传、重试安全、配置
node tests/discriminator.test.mjs  #  7 项：真实的工具声明
```

`discriminator.test.mjs` 从随发行版分发的工具**源码**里读出参数名，再用 DSH 自己的
`parameterSchemaSpecToJsonSchema` 归一化，因此「是否限时」这个判断是针对**真实声明**证明的，而不是
对着手写的假数据。它需要本机装有 `@deepseek-ai/dsh` 才能读取那些文件。

## 设计说明

- **不覆盖预设。** profile patch 无法伸进预设的 `plugins` 列表——那个列表是 `preset-<id>` 行的
  `config` 数据，不是 Loader group。实测针对 `persistent-shell` 打补丁会得到
  `patch insert: entry "persistent-shell" not found`。而改打 `preset-minimal` 则意味着每次上游升级
  都要把整个随发行版分发的预设重述一遍。
- **不注入 `terminals`。** 极简模式的 `terminals` 提供者位于预设 `isolate: terminals: true` 的
  作用域内，宿主平面的行够不到。`tools/execute` 瀑布是能看见所有预设的公共接缝。
- **最小改动面：** 插入一行、注入一个服务（`tools`）、不新增工具、不改 prompt、不动任何本来正常的模式。

## 许可

MIT
