/**
 * The provider card's copy. One dictionary per supported locale; the keys are
 * the card's whole visible surface, so a missing entry is a type error.
 */
export const LOCALE_NS = 'settings.googleCloud'

/** Every visible string of the card. */
export interface Labels {
  /** Index signature the locale registry's dictionary type requires. */
  [key: string]: string
  projectId: string
  projectIdHint: string
  projectIdMissing: string
  location: string
  locationHint: string
  proxy: string
  proxyHint: string
  apiKey: string
  apiKeyHint: string
  apiKeySet: string
  apiKeyUnset: string
  models: string
  modelsHint: string
  modelsInvalid: string
  advanced: string
  summarize: string
  expand: string
  collapse: string
  unconfigured: string
  save: string
  saving: string
  reset: string
  saved: string
  rejected: string
  readOnly: string
  unavailable: string
  loading: string
}

export const en: Labels = {
  projectId: 'Project ID',
  projectIdHint:
    'Google Cloud project id or project number, for example my-project-123456. It becomes projects/<id> in the request path.',
  projectIdMissing: 'A project id is required before Gemini can be reached.',
  location: 'Location',
  locationHint: 'Use global for Gemini 4 Argon; a regional model uses its own location, such as us-central1.',
  proxy: 'Proxy',
  proxyHint:
    'Empty connects directly. Use http://, https://, socks5:// or socks5h:// (socks5h resolves the host at the proxy), or auto to read HTTPS_PROXY/ALL_PROXY.',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file through the credentials service. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured for this reference.',
  models: 'Extra models',
  modelsHint:
    'Models discovered from the publisher list are added automatically. These lines stay available when the provider cannot be asked: id | display name | context window | max output tokens. The trailing fields are optional.',
  modelsInvalid: 'Every model line needs a valid id and, when present, positive whole numbers for the two capacities.',
  advanced: 'Fallback catalog',
  summarize: 'Gemini on the Gemini Enterprise Agent Platform (Vertex AI).',
  expand: 'Configure',
  collapse: 'Hide settings',
  unconfigured: 'not configured',
  save: 'Save',
  saving: 'Saving…',
  reset: 'Reset',
  saved: 'Saved. New requests use these values immediately.',
  rejected: 'The Host did not accept these values; the draft is kept for correction.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The Host plugin that serves this card is not loaded, so there is nothing to configure.',
  loading: 'Loading the current configuration…',
}

export const zh: Labels = {
  projectId: '项目 ID',
  projectIdHint: 'Google Cloud 项目 ID 或项目编号，例如 my-project-123456；它会成为请求路径中的 projects/<id>。',
  projectIdMissing: '必须先填写项目 ID，才能访问 Gemini。',
  location: '区域',
  locationHint: 'Gemini 4 Argon 使用 global；区域模型请填它所在的区域，例如 us-central1。',
  proxy: '代理',
  proxyHint:
    '留空表示直连。可填 http://、https://、socks5:// 或 socks5h://（socks5h 由代理解析域名），填 auto 读取 HTTPS_PROXY/ALL_PROXY。',
  apiKey: 'API Key',
  apiKeyHint: '通过凭据服务保存在设置文件之外。留空表示保持当前密钥。',
  apiKeySet: '已配置密钥。',
  apiKeyUnset: '该凭据引用尚未配置密钥。',
  models: '补充模型',
  modelsHint:
    '会自动从提供方公布的模型列表补充可用模型。无法访问该列表时使用这里的行：id | 显示名称 | 上下文窗口 | 最大输出 token；后两项可省略。',
  modelsInvalid: '每个模型行都需要合法的 id；填写容量时必须是正整数。',
  advanced: '候选模型目录',
  summarize: '通过 Gemini Enterprise Agent Platform（Vertex AI）使用 Gemini。',
  expand: '配置',
  collapse: '收起设置',
  unconfigured: '未配置',
  save: '保存',
  saving: '保存中…',
  reset: '重置',
  saved: '已保存，下一次请求立即生效。',
  rejected: '本部署没有接受这些值，已保留草稿供你修改。',
  readOnly: '本部署的设置为只读。',
  unavailable: '承载此卡片的 Host 插件未加载，暂时没有可配置的内容。',
  loading: '正在读取当前配置…',
}

/** Resolve every label through one translator. */
export function labelsOf(t: (key: string) => string): Labels {
  const labels: Record<string, string> = {}
  for (const key of Object.keys(en)) labels[key] = t(key)
  return labels as unknown as Labels
}
