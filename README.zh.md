# dsh-google-cloud-llm

[简体中文](README.zh.md) | [English](README.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中通过 **Gemini Enterprise Agent Platform（Vertex AI）** 使用 Gemini 模型。插件注册 `google-cloud` 路由并登记到模型页的提供方列表；**设置 → Models** 里那一行 **Google Cloud** 就是唯一配置入口（项目 ID、区域、Base URL、代理、API Key、候选模型目录）。插件不新增任何设置页。

## 能力

**对话与流式**

- 原生 `streamGenerateContent`（SSE）流式输出，逐 token 转成 Harness 的 `text-delta` / `reasoning-delta`。
- 原生 function calling：`functionCall` / `functionResponse` 收发；Gemini 返回的 `thoughtSignature` 与原生 parts 存入 `replayState`，下一轮原样回放，多轮工具循环不会被 400 拒绝。回放信封带模型名，换了模型或换了提供方的历史不会被误用。
- 思考摘要：`off` / `low` / `medium` / `high`。Gemini 2.5 用 `thinkingBudget`（low 1024 / medium 8192 / high 24576，Pro 为 32768；Pro 无法关闭思考，`off` 用 `-1` 动态预算）；Gemini 3 及以后用 `thinkingLevel`，其中 3.0 / 3.1 / 3.5 / 3.6 的 Flash 与 Flash-Lite 的 `off` 落到 `MINIMAL`，其余落到 `LOW`。`off` 是最低档且不返回思考内容。
- 用量统计：输入、输出、思考 token 与缓存命中 token。
- 流空闲超时：默认 300 秒没有新事件就以 `TIMEOUT` 失败（`streamIdleTimeoutMs` 可调）；上层取消信号会立即断开连接并以 `ABORTED` 结束。

**输入**

- 图片输入：`type: 'image'` 的块投影成 Gemini `inlineData`。附件按五级链路解析——`attachments.readImageRequest`（缩放到 2048×2048、上限 4 MB）→ `attachments.readImage` → `attachments.imageHostPath` → 引用自带的 `path` / `readonlyPath` → DSH 内容寻址存储（`$DSH_HOME/attachments/v1/objects/…` 或 `~/.dsh/attachments/v1/objects/…`）；全部失败才退化成 `[image attachment omitted by this route]` 占位文本。
- 文件附件以 `[file <name>]` 占位文本传递。

**请求整形**（每一条都是被 Vertex 的 400 教出来的）

- 用户轮内的纯文本 part 一律排在 `functionResponse` 之前：Vertex 会把「functionResponse 后跟文本」的用户轮误判成以模型轮结尾，整轮 400（`Requests ending with a model turn are not supported`）。
- 结尾没有工具结果的 model 轮直接丢弃：中断的会话会留下「模型发了 functionCall、结果没回来」的尾巴，留着会让之后每一次请求都失败。
- 工具结果以**文本**回填 `functionResponse.response.result`：Gemini 会把响应里的 `$ref` 成员当成「响应分片引用」，工具返回 JSON Schema（`$defs`/`$ref`）时整轮会被 400 拒绝（`The referenced name "#/$defs/…" … does not match to a display_name`），所以不解析成对象；超过 512 KB 截断；名字不在本轮已声明工具里的结果也退回文本。
- 工具 schema 清洗成 Vertex 接受的 OpenAPI 子集：剥掉 `$schema`、`$id`、`$ref`、`$defs`、`$comment`、`additionalProperties`、`patternProperties`、`unevaluatedProperties`、`dependentSchemas`、`examples`、`default`、`oneOf`；`const` 转成单值 `enum`；`type: [T, "null"]` 转成 `type: T` + `nullable: true`。

**目录与网络**

- 模型列表自动更新：优先调用 `publishers/google/models`（先 `/v1`，失败再 `/v1beta1`，6 秒超时），过滤掉 image / tts / live / embedding / omni / nano-banana 等非聊天模型，并要求 `supportedActions` 含 `generateContent`；成功时与配置目录合并，失败（Express API Key 常无权列出）回退到配置目录。结果缓存 24 小时。
- 模型 id 归一化：`gemini-3-5-flash` → `gemini-3.5-flash`，历史会话里的旧写法照样能解析。
- 未知模型兜底：会话恢复时遇到目录里没有的 id，会先向端点刷新一次目录再决定是否拒绝。
- **代理**：`http://`、`https://`、`socks5://`、`socks5h://`，支持用户名密码；`auto` 读取 `HTTPS_PROXY` / `ALL_PROXY` 等并遵守 `NO_PROXY`。
- 跨提供方历史：别的模型产生的、没有 Gemini 签名的工具调用自动降级为文本，切换模型不会让会话失效。
- 凭据校验：密钥为空或含非 ASCII 字符时，在进 socket 之前就以 `INVALID_CREDENTIAL` 拒绝，不会变成一个看不懂的 HTTP 400。
- 诊断：请求被拒时把形状（角色与 part 类型，**不含正文**）写到系统临时目录的 `dsh-google-cloud-rejection.json`，事后能直接看出是哪种 part 组合被拒。

**界面**

- 提供方卡片同时支持两种姿态：「添加模型提供方」面板（`configured === false`）与已配置行（`configured === true`）。折叠时只显示「项目 ID · 密钥状态 · 模型数」摘要，展开后才是字段表单。
- 卡片表单会被搬进 DSH 原生的 ProviderEditor 容器，并接管它的「取消 / 应用」按钮：取消 = 丢弃草稿，应用 = 先写凭据再写设置，成功后自动收起。DSH 自带的「编辑」按钮只控制它自己的通用编辑器，对第三方提供方没有可用字段。
- 中英文案：`en` / `zh` 两套字典注册在 `settings.googleCloud` 命名空间，跟随 Harness 语言切换；`locale/*.json` 提供插件列表里的标题与描述。

## 安装与构建

源码是 TypeScript，用 [tsdown](https://tsdown.dev) 构建（与官方包同构：`src/` → `lib/`）：

```sh
npm install        # 只装类型与构建工具，运行时不依赖这些包
npm run build      # tsdown + scripts/wrap-client.ts → lib/index.js、lib/client.js
npm run typecheck  # tsc --noEmit
npm test           # 离线测试：本地 HTTP / HTTP 代理 / SOCKS5 代理 / 目录发现 / 卡片
```

测试全部离线，不需要真实凭据：`test/host-smoke.test.ts` 起一个本地假 Vertex 端点，覆盖直连、带认证的 HTTP 代理、带认证与不带认证的 SOCKS5、目录发现与回退、工具调用与回放、`$ref` 工具结果、跨提供方历史、尾部未回答的 model 轮、文本与 `functionResponse` 的顺序、图片与附件投影；`test/client-smoke.test.ts` 加载构建产物 `lib/client.js`，验证卡片注册、折叠摘要、保存路径与「密钥走凭据、不进设置文件」。

宿主侧把本目录作为 profile bundle 安装（安装后重启一次 Harness）：

```sh
dsh plugin --profile desktop add file:/absolute/path/to/dsh-gcloud
```

`lib/` 已随仓库提供，安装即可用；改源码后重新 `npm run build` 并重装。

## 配置

**设置 → Models → Google Cloud** 行。

| 字段 | 说明 |
| --- | --- |
| 项目 ID | 必填。项目 ID 或项目编号，会成为请求路径里的 `projects/<id>`。 |
| 区域 | 默认 `global`。Gemini 4 Argon 只在 `global` 提供，填其他区域会 404；区域模型请填它自己的区域，例如 `us-central1`。 |
| Base URL | 可选。留空按区域推导；需要走网关或私有端点时填完整地址，会作为所有请求路径的前缀。 |
| 代理 | 留空直连（也可写 `direct` / `none`）；`http://host:port`、`https://host:port`、`socks5://host:port`、`socks5h://host:port`；带认证写 `scheme://user:pass@host:port`；`auto` 读环境变量。 |
| API Key | 通过凭据服务保存为 `GOOGLE_CLOUD_API_KEY`，不写入设置文件；输入框留空表示保持当前密钥。 |
| 候选模型目录 | 每行 `id \| 显示名称 \| 上下文窗口 \| 最大输出 token \| 模态`；后三项可省略，模态写 `text,image`。目录接口不可用时使用这些行，可用时与发现结果合并。 |

保存后写入 profile 的 `cordis.patch.yml`，下一次模型请求生效，不需要重启。然后在对话的模型选择器里选择 **Google Cloud** 分组下的模型。

也可以直接在 `cordis.patch.yml` 里覆盖同一行（`id: llm-google-cloud`）。推荐用 `providers` 字典按路由 id 存配置：

```yaml
- id: llm-google-cloud
  name: 'dsh-google-cloud-llm'
  config:
    provider: google-cloud
    providers:
      google-cloud:
        displayName: Google Cloud
        projectId: my-project-123456
        location: global
        baseURL: ''                      # 留空按区域推导
        proxy: socks5://127.0.0.1:1080
        apiKeyEnv: GOOGLE_CLOUD_API_KEY
        streamIdleTimeoutMs: 300000
        models:
          - id: gemini-4-argon
            name: Gemini 4 Argon
            contextWindow: 1048576
            maxTokens: 1048576
            inputModalities: [text, image]
```

字段也可以直接写在行顶层（旧写法，仍然支持）：`providers` 里没有对应条目时，顶层的 `projectId` / `location` / `baseURL` / `proxy` / `apiKeyEnv` / `models` / `streamIdleTimeoutMs` 会被当作同一份配置读取；卡片首次保存时会把它迁进 `providers.<route>` 并清理顶层残留字段。

默认候选目录包含 12 个 Gemini 模型：4 Argon、3.8 / 3.7 / 3.6 / 3.5 Flash、3.5 / 3.1 Flash-Lite、3.1 Pro (Preview)、3 Flash (Preview)、2.5 Pro / Flash / Flash-Lite，上下文窗口均为 1M。

## 请求与代理

```
POST {base}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: <API Key>
```

`base` 默认按区域推导（`global` → `https://aiplatform.googleapis.com`，多区域 `us` / `eu` → `https://aiplatform.{location}.rep.googleapis.com`，其他区域 → `https://{location}-aiplatform.googleapis.com`），可用 `baseURL` 覆盖。直连与代理都走同一个 Node HTTP/1.1 客户端（`fetch` 不会自动走代理，所以连接由插件自己持有）：

- `http://` 代理：先发 `CONNECT`，认证用 `Proxy-Authorization: Basic`；
- `https://` 代理：先与代理建立 TLS，再发 `CONNECT`，随后与目标再建一层 TLS；
- `socks5` / `socks5h`：RFC 1928 握手，无认证或用户名/密码认证；域名始终交给代理解析（等价 `socks5h`）。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 入口：注册适配器与提供方目录条目，解析凭据与图片附件 |
| [`src/config.ts`](src/config.ts) | `Config` schema、默认值、`providers` 字典与纯值快照 |
| [`src/transport.ts`](src/transport.ts) | 直连 / HTTP CONNECT / SOCKS5 传输与请求 |
| [`src/adapter.ts`](src/adapter.ts) | `LlmAdapter`：请求投影、SSE 状态机、思考档位、签名回放、空闲超时 |
| [`src/catalog.ts`](src/catalog.ts) | 模型目录发现、过滤、缓存与回退 |
| [`src/projection.ts`](src/projection.ts) | 消息、图片与工具 schema → Gemini parts |
| [`src/errors.ts`](src/errors.ts) | 可分类的失败对象与 API Key 校验 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：注册卡片、挂载语言字典 |
| [`src/client/card.tsx`](src/client/card.tsx) | 卡片组件（折叠摘要 + 字段 + 保存） |
| [`src/client/form.ts`](src/client/form.ts) | 草稿、凭据探测、设置写入与原生编辑器的 DOM 桥 |
| [`src/client/locales.ts`](src/client/locales.ts) | 卡片文案字典（`en` / `zh`） |
| [`src/client/harness.ts`](src/client/harness.ts) | Harness 客户端服务与槽位的类型接线 |
| [`locale/*.json`](locale) | 插件列表里的标题与描述（`en` / `zh`） |
| [`cordis.patch.yml`](cordis.patch.yml) | profile bundle 的插入行（行 id 即设置命名空间，不可改名） |
| [`scripts/wrap-client.ts`](scripts/wrap-client.ts) | 把 CJS bundle 包成 `window.__ModuleLoader__` 形式 |
| [`test/host-smoke.test.ts`](test/host-smoke.test.ts) | 离线 Host 端测试（传输、目录、投影、回放） |
| [`test/client-smoke.test.ts`](test/client-smoke.test.ts) | 离线客户端测试（构建产物加载、卡片保存） |

## 错误码

失败都带 `code` 与 `failure` 两个属性，Harness 的归一化器据此分类重试。

| 错误码 | 触发场景 |
| --- | --- |
| `MISSING_CREDENTIAL` | 没填项目 ID，或凭据引用解析不到密钥。 |
| `INVALID_CREDENTIAL` | 密钥为空，或含 HTTP 头无法承载的字符。 |
| `INVALID_CONFIG` | 代理设置不是 URL，或协议不是 http / https / socks5 / socks5h。 |
| `UNKNOWN_MODEL` | 模型既不在配置目录、也不在刷新后的发现结果里。 |
| `INVALID_REQUEST` | 请求没有可见内容、提示被安全策略拦截、或端点返回 4xx。 |
| `AUTH` / `RATE_LIMIT` / `SERVER` | 端点返回 401·403 / 429 / 5xx。 |
| `TIMEOUT` | 建立连接或等待下一个 SSE 事件超过上限。 |
| `ABORTED` | 上层取消了请求。 |
| `TRANSPORT` | 连不上端点，或代理握手失败。 |
| `EMPTY_RESPONSE` | 流正常结束但没有任何可见内容。 |

## 已知限制

- **仅支持 Express API Key**：不支持 Service Account / ADC，密钥来自凭据服务或环境变量。
- **模型列表接口依赖权限**：Express API Key 可能被列表接口拒绝，此时回退到配置目录，不影响对话。
- **切换提供方会丢失签名**：其他提供方的工具调用没有 Gemini 签名，回放时降级为文本。
- **`off` 不是关闭思考**：它只是最低档。Gemini 3 / 4 走 `thinkingLevel`（`off` → `MINIMAL` 或 `LOW`），2.5 Pro 的最低预算是 128。
- **代理口令写在 URL 里**：会随配置进入 profile 的 `cordis.patch.yml`，敏感环境请用环境变量或 `auto`。
- **图片只有一轮大小上限**：超过 4 MB 或 2048×2048 的附件会被 `readImageRequest` 缩放；解析不到数据的图片退化成占位文本。

## License

MIT。构建产物内联了 `@deepseek-ai/schemastery`（MIT）与其依赖 `@deepseek-ai/cosmokit`（MIT）。
