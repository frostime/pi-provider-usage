# Provider 说明

查询规则来自上游 `pi-usage`，保留 Provider 自身的额度、余额和支出语义。表中的 ID 可直接用于 `/provider-usage <id>`；补全会根据 Pi 配置筛选。

| Provider ID | 返回内容 |
| --- | --- |
| `openai-codex`（简写 `codex`） | ChatGPT 订阅额度窗口、模型分组、积分和可用重置额度数量；只读，不兑换 |
| `opencode-go` | OpenCode Go 滚动、周、月额度窗口 |
| `openai` | 原生 ChatGPT OAuth 认证状态和用量网页链接；没有数值额度 |
| `github-copilot` | AI credits、premium requests 或 Free-plan chat allowance，按实际响应区分 |
| `kimi-coding` | Kimi Coding Plan 请求窗口和独立 booster wallet |
| `openrouter` | 当前 API key 的额度限制和支出窗口 |
| `deepseek` | 当前 CNY、USD API 余额，分别显示 |
| `fireworks` | 一个计费账号的过去 30 天 rated spend，按币种显示 |
| `vercel-ai-gateway` | 当前团队的 USD credits 和累计支出 |
| `baseten` | 组织范围过去 30 天 Model APIs 抵扣后的支出；不包含 Dedicated/Training |
| `moonshotai` | Moonshot Global 当前 USD API 余额 |
| `moonshotai-cn` | Moonshot China 当前 CNY API 余额 |
| `minimax` | MiniMax Global Token Plan 窗口或 pay-as-you-go API 余额 |
| `minimax-cn` | MiniMax China Token Plan 窗口或 pay-as-you-go API 余额 |
| `xai` | 匹配的 xAI OAuth 订阅额度与 credits；不支持 API key 或 Management API |
| `zai` | GLM Coding Plan 额度窗口、MCP allowance、套餐名称和续期日期 |
| `zai-coding-cn` | 中国区域 GLM Coding Plan 额度窗口、MCP allowance、套餐名称和续期日期 |

## 认证与接口边界

- 使用 Pi 当前解析的 Provider 认证。查询当前 Provider 时还会检查模型级认证覆盖，不以另一个已存储登录代替当前认证。
- 仅接受匹配的官方模型/认证地址，不将自定义或代理凭证发送给官方用量接口。请求拒绝 HTTP 重定向。
- 原生 `openai` OAuth 与旧 `openai-codex` 是不同契约。前者只本地校验完整、匹配的原生 ChatGPT grant，不向旧 ChatGPT backend 发送其令牌。
- GitHub Copilot、原生 OpenAI 和 xAI 的 OAuth 解析保留上游进程内 `oauth:credential-source:v1` 与 `oauth:credential-readiness:v1` 协议，并保留独立使用时的 Pi 凭证回退。
- Moonshot Global/China 共用 `MOONSHOT_API_KEY` 的情况保留区域保护，不凭共享变量自动推断另一个区域的账号。
- MiniMax 根据实际凭证类型选择对应接口，不通过轮流请求不同接口猜测类型；矛盾的计数和百分比不猜测显示。
- Fireworks 多计费账号不自动聚合，也不擅自选第一个，详见 [查询行为](operations.md)。

## 主要数据来源

Provider 的准确接口、认证要求与响应解析以 `src/query.ts` 和 `src/providers/` 为准。核心来源包括：

- Codex：`https://chatgpt.com/backend-api/wham/usage`
- OpenCode Go：`https://opencode.ai/zen/go/v1/usage`
- Copilot：`https://api.github.com/copilot_internal/user`
- Kimi：`https://api.kimi.com/coding/v1/usages`
- OpenRouter：`https://openrouter.ai/api/v1/key`
- DeepSeek：`https://api.deepseek.com/user/balance`
- Fireworks：官方账号列表和单账号 billing summary
- Vercel AI Gateway：`https://ai-gateway.vercel.sh/v1/credits`
- Baseten：`https://api.baseten.co/v1/billing/usage_summary`
- Moonshot：匹配区域的 `/v1/users/me/balance`
- xAI：Grok CLI proxy 的 user/subscription 与 billing/credits 接口

有些接口是 Provider 自有的内部接口，并非稳定公共 API。数据是查询时的快照，不等于 Pi 本次会话消耗；币种、账号与计费语义不能直接相加。

上游的完整契约说明和历史记录链接见 [来源记录](../UPSTREAM.md)。
