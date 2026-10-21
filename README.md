# dsh-google-cloud-llm

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中通过 **Gemini Enterprise Agent Platform（Vertex AI）** 使用 Gemini 模型。插件注册 `google-cloud` 路由并登记到模型页的提供方列表；**设置 → Models** 里那一行 **Google Cloud** 就是唯一配置入口（API Key、项目 ID、区域、代理、模型目录）。插件不新增任何设置页。

## 能力

- 原生 `streamGenerateContent`（SSE）流式输出，逐 token 转成 Harness 的 `text-delta` / `reasoning-delta`。
- 原生 function calling：`functionCall` / `functionResponse` 收发；Gemini 返回的 `thoughtSignature` 与原生 parts 存入 `replayState`，下一轮原样回放，多轮工具循环不会被 400 拒绝。
- 思考摘要：`off` / `low` / `medium` / `high`，按模型选择 `thinkingLevel`（Gemini 4 / 3）或 `thinkingBudget`（Gemini 2.5）。`off` 是最低档且不返回思考内容——Gemini 4 Argon 无法真正关闭思考。
- 用量统计：输入、输出、思考 token 与缓存命中 token。
- 模型列表自动更新：优先调用 `publishers/google/models`，成功时并入发现的 Gemini 聊天模型；失败（Express API Key 常无权列出）回退到设置里的模型目录，结果缓存 10 分钟。
- **代理**：`http://`、`https://`、`socks5://`、`socks5h://`，支持用户名密码；`auto` 读取 `HTTPS_PROXY`/`ALL_PROXY` 并遵守 `NO_PROXY`。
- 跨提供方历史：别的模型产生的、没有 Gemini 签名的工具调用自动降级为文本，切换模型不会让会话失效。
- 用户轮内的纯文本 part 一律排在 `functionResponse` 之前：Vertex 会把「functionResponse 后跟文本」的用户轮误判成以模型轮结尾，整轮 400（`Requests ending with a model turn are not supported`）；文本前置可避开。
- 工具结果以**文本**回填 `functionResponse.response.result`：Gemini 会把响应里的 `$ref` 成员当成“响应分片引用”，工具返回 JSON Schema（`$defs`/`$ref`）时整轮会被 400 拒绝（`The referenced name "#/$defs/…" … does not match to a display_name`），所以这里不解析成对象；超过 512 KB 截断；名字不在本轮已声明工具里的结果也退回文本。
- 输入模态目前是 **text**：图片会被 Harness 投影成占位文本。

## 安装与构建

源码是 TypeScript，用 [tsdown](https://tsdown.dev) 构建（与官方包同构：`src/` → `lib/`）：

```sh
npm install        # 只装类型与构建工具，运行时不依赖这些包
npm run build      # tsdown + scripts/wrap-client.mjs → lib/index.js、lib/client.js
npm test           # 离线测试：本地 HTTP / HTTP 代理 / SOCKS5 代理
```

宿主侧把本目录作为 profile bundle 安装（安装后重启一次 Harness）：

```sh
dsh plugin --profile desktop add file:/absolute/path/to/dsh-gcloud
```

`lib/` 已随仓库提供，安装即可用；改源码后重新 `npm run build` 并重装。

## 配置

**设置 → Models → Google Cloud** 行。行卡片默认折叠，显示项目 ID / 密钥 / 模型数的摘要；点卡片里的「配置」展开字段（DSH 自带的「编辑」按钮只控制它自己的通用编辑器，对第三方提供方没有可用字段）。

| 字段 | 说明 |
| --- | --- |
| 项目 ID | 必填。项目 ID 或项目编号，会成为请求路径里的 `projects/<id>`。 |
| 区域 | 默认 `global`。Gemini 4 Argon 只在 `global` 提供，填其他区域会 404。 |
| 代理 | 留空直连；`http://host:port`、`https://host:port`、`socks5://host:port`、`socks5h://host:port`；带认证写 `scheme://user:pass@host:port`；`auto` 读环境变量。 |
| API Key | 通过凭据服务保存为 `GOOGLE_CLOUD_API_KEY`，不写入设置文件。 |
| 候选模型目录 | 每行 `id \| 显示名称 \| 上下文窗口 \| 最大输出 token`；列表接口不可用时使用这些行。 |

保存后写入 profile 的 `cordis.patch.yml`，下一次模型请求生效，不需要重启。然后在对话的模型选择器里选择 **Google Cloud** 分组下的模型。

也可以直接在 `cordis.patch.yml` 里覆盖同一行（`id: llm-google-cloud`）：

```yaml
- id: llm-google-cloud
  name: 'dsh-google-cloud-llm'
  config:
    projectId: my-project-123456
    location: global
    proxy: socks5://127.0.0.1:1080
    apiKeyEnv: GOOGLE_CLOUD_API_KEY
    models:
      - id: gemini-4-argon
        name: Gemini 4 Argon
        contextWindow: 1048576
        maxTokens: 1048576
```

## 请求与代理

```
POST {base}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
x-goog-api-key: <API Key>
```

`base` 默认按区域推导（`global` → `https://aiplatform.googleapis.com`，多区域 `us` / `eu` → `https://aiplatform.{location}.rep.googleapis.com`，其他区域 → `https://{location}-aiplatform.googleapis.com`），可用 `baseURL` 覆盖。直连与代理都走同一个 Node HTTP/1.1 客户端：

- `http://` 代理：先发 `CONNECT`，认证用 `Proxy-Authorization: Basic`；
- `https://` 代理：先与代理建立 TLS，再发 `CONNECT`，随后与目标再建一层 TLS；
- `socks5` / `socks5h`：RFC 1928 握手，无认证或用户名/密码认证；域名始终交给代理解析（等价 `socks5h`）。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 入口：注册适配器与提供方目录条目 |
| [`src/config.ts`](src/config.ts) | `Config` schema、默认值与纯值快照 |
| [`src/transport.ts`](src/transport.ts) | 直连 / HTTP CONNECT / SOCKS5 传输与请求 |
| [`src/adapter.ts`](src/adapter.ts) | `LlmAdapter`：请求投影、SSE 状态机、签名回放 |
| [`src/catalog.ts`](src/catalog.ts) | 模型目录发现、缓存与回退 |
| [`src/projection.ts`](src/projection.ts) | 消息与工具 schema → Gemini parts |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：注册模型页卡片 |
| [`src/client/card.tsx`](src/client/card.tsx) | 卡片组件（折叠摘要 + 字段 + 保存） |
| [`src/client/form.ts`](src/client/form.ts) | 草稿、凭据探测与设置写入 |
| [`src/client/harness.ts`](src/client/harness.ts) | Harness 客户端服务与槽位的类型接线 |
| [`scripts/wrap-client.mjs`](scripts/wrap-client.mjs) | 把 CJS bundle 包成 `window.__ModuleLoader__` 形式 |

## 已知限制

- **仅文本输入**：路由声明 `inputModalities: ['text']`。
- **模型列表接口依赖权限**：Express API Key 可能被列表接口拒绝，此时回退到配置目录，不影响对话。
- **切换提供方会丢失签名**：其他提供方的工具调用没有 Gemini 签名，回放时降级为文本。
- **`off` 不是关闭思考**：Gemini 4 Argon 不接受 `thinkingBudget: 0`。
- **不支持 Service Account / ADC**：只有 Express API Key（以及环境变量）。
- **代理口令写在 URL 里**：会随配置进入 profile 的 `cordis.patch.yml`，敏感环境请用环境变量或 `auto`。

## License

MIT。构建产物内联了 `@deepseek-ai/schemastery`（MIT）与其依赖 `@deepseek-ai/cosmokit`（MIT）。
