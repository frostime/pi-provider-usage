# @frostime/pi-provider-usage

一个只负责查询 Provider 用量的 Pi 扩展，基于 [pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage) 精简而来。

## 使用

```text
/provider-usage                 查询当前模型的 Provider
/provider-usage codex           查询 OpenAI Codex
/provider-usage opencode-go     查询 OpenCode Go
/provider-usage all             查询所有已配置且受支持的 Provider
```

输入 `/provider-usage ` 后补全参数。补全只列出已配置的、内置支持的 Provider 和 `all`；`codex` 是 `openai-codex` 的简写，完整 ID 也可使用。查询其他 Provider 不会切换当前模型。

- 直接使用 Pi 的认证，不要求重复配置密钥。
- 每次命令重新查询；没有后台轮询、状态栏或用量缓存。
- `all` 最多同时查询两个 Provider，分别显示结果；某个失败不影响其他结果。
- 没有设置菜单、`/fast`、请求改写或额度兑换。
- TUI 使用右侧临时浮层，不抢主编辑器焦点、不暂停 streaming，也不写入会话记录或模型上下文。RPC 使用通知返回结果；不支持 print/JSON 模式。

浮层显示查询进度和快照时间，不自动刷新。只在浮层打开时启用以下快捷键，其他输入照常交给主界面：

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+Alt+R` | 重新查询当前范围；`all` 会重新检查已配置的 Provider |
| `Ctrl+Alt+Q` | 关闭浮层，并取消尚未完成的查询 |
| `Ctrl+Alt+↑/↓` | 滚动长结果 |

再次执行命令会替换已有浮层，不叠加窗口。关闭、模型或会话切换、退出后会清理浮层和输入监听。普通 `Q`、Esc、Enter 不会被用量浮层拦截。

## 从 npm 安装

```bash
pi install npm:@frostime/pi-provider-usage
```

## 从 GitHub 安装

```bash
pi install git:github.com/frostime/pi-provider-usage
```

## 本地加载

需要支持非抢焦点浮层、终端输入监听和有效认证地址校验的 Pi；开发与测试使用 Pi **1.0.2**。

```bash
# 在本仓库目录执行，仅本次启动加载
pi -e .

# 或注册为个人本地扩展
pi install .
```

直接加载 TypeScript 源码，无需构建。没有第三方运行时依赖；Pi 提供宿主包。

开发检查：

```bash
npm ci --ignore-scripts
npm run check
```

## 支持范围与限制

保留上游的 17 个 Provider ID，完整列表见 [Provider 说明](docs/providers.md)。不同 Provider 分别返回订阅额度、余额或支出，不将不同币种和计费语义混合。

- 原生 `openai` ChatGPT OAuth 只能显示认证状态和用量网页链接，不能查询数值额度；`openai-codex` 可以查询数值额度。OpenAI API-key 用量查询不受支持。
- Fireworks 只有一个可见计费账号时自动查询；多个账号时提示需要指定账号。当前版本没有账号选择功能，不默认选第一个，也不汇总。
- 一个 Provider 查询使用 Pi 当前解析出的认证，不遍历其他已保存账号。
- 自定义或代理地址的凭证不会被转发到官方用量接口。官方接口可能变化，返回的数据也可能有延迟。

查询、超时与取消行为见 [操作说明](docs/operations.md)。

## 安全与来源

扩展与 Pi 使用相同的进程权限，只加载你信任的代码。认证仅用于请求匹配的官方接口；保留地址校验、请求边界认证复核、错误脱敏和响应大小限制，拒绝 HTTP 重定向。结果不保存密钥或令牌。

来源快照与修改范围见 [UPSTREAM.md](UPSTREAM.md)。许可证为 [MIT](LICENSE)，保留上游版权声明。
