# DSH Hindsight 管理

DSH 插件：在“设置 → Hindsight”中配置全局模型，直接使用嵌入的 Hindsight 原生控制台并自动登录。模型复用 DSH 已有服务商配置，不复制服务商密钥，不修改 Hindsight 源码或现有部署。

## 安装

要求 Node.js 22+，DSH 宿主提供 `llm.listProviders`、`llm.listModels`、`llm.stream`、`webServer`、`connection.authorizeIndex` 和插件配置页插槽。Hindsight 控制台需要支持 `/api/version` 和原生访问密钥认证。本机 Hindsight 1.2.0 的接口已用于对照实现。

```sh
npm install
npm test
npm run build
npm pack --ignore-scripts
```

在 DSH 插件管理器中安装生成的 `dsh-hindsight-0.1.3.tgz`，打开“设置 → Hindsight”。控制台及模型配置都在此处，原插件配置页不再重复显示。桌面 Profile 由 Electron 应用独占管理；Web Profile 也可通过 DSH CLI 安装：

```sh
dsh plugin --profile web add /absolute/path/dsh-hindsight-0.1.3.tgz
```

## 原生控制台与免密登录

打开页面后会自动嵌入原生控制台，无需手动输入密钥。默认连接已有配置中的控制台地址，未配置时使用 `http://localhost:9999`（不是 API 服务的 `8888`）。需要调整端口或部署路径时，可在插件配置中设置 `consoleUrl`。

后台按以下顺序取得已有凭据：

1. DSH 进程的 `HINDSIGHT_CP_ACCESS_KEY` 环境变量。
2. 本机 Docker 中与控制台实际发布端口精确匹配的唯一运行容器的同名环境变量。需要 Docker CLI 可用，且 DSH 有权限读取该容器信息。

未启用认证时直接嵌入，不读取凭据。找不到凭据、容器匹配有歧义或自动登录失败时，会显示配置提示和重试按钮，不自动关闭控制台认证。不支持替代 SSO/OAuth。

插件通过原生登录 API 换取会话，原生 Cookie 只保留在后台内存；密钥不写入磁盘、JSON 响应、URL 或浏览器存储。iframe 使用 DSH 同源路径 `/.well-known/dsh-hindsight/console/`，继承宿主鉴权。手机通过已配对的 DSH 远程入口即可访问，不会请求手机自身的 `localhost:9999`，也不依赖远程入口转发原生 Cookie。

原生控制台仍只需在 DSH 宿主机回环地址可达。代理处理原生页面资源和跳转，不修改 Hindsight 源码、部署或认证配置。当前原生 Next 未配置代理前缀，跨页面导航回退为完整页面加载；记忆库路径解析兼容已对照的 Hindsight 1.2.0，升级原生控制台后需重新验收。

页面重新打开或点击“重新载入”时，会重新取得有效原生会话。iframe 内保留原生控制台的导航与管理操作。插件自建的登录、退出和只读记忆库列表已移除。

管理接口和模型转接仅接受本机请求；手机管理页由 DSH 已配对的远程入口转发。原生控制台代理也必须经过宿主 `connection` 鉴权，未登录请求不会访问上游。上游控制台仅支持宿主机回环地址，不支持跨站 SSO/OAuth。

## 全局模型

在“设置 → Hindsight”选择 DSH 已有模型，点击“保存默认模型并生成环境文件”。配置文件默认保存在 `<DSH_HOME>/dsh-hindsight/hindsight.env`，目录权限 `0700`、文件权限 `0600`，包含私有转接令牌，禁止提交到 Git 或分享。

首次接入时，让 Hindsight **服务进程**加载该环境文件，再按现有部署方式重启。文件生成不代表运行中的 Hindsight 已加载。对于直接运行的本机服务，可以在它的启动 shell 中使用：

```sh
set -a
. /absolute/path/to/dsh-hindsight/hindsight.env
set +a
# 在此 shell 中执行你现有的 Hindsight 启动命令。
```

Docker Compose 可在现有 Hindsight 服务中通过 `env_file` 引用该文件，然后由你重建服务。Compose 的显式 `environment` 会覆盖 `env_file` 中的同名字段，应检查冲突。修改 `.env` 或 `env_file` 后仅 `docker restart` 不会载入新环境。

**网络前提：**网关默认只监听 `127.0.0.1:18991`。Hindsight 必须能访问这个本机地址；容器的 `127.0.0.1` 指向容器自身，需自行采用可达主机回环地址的网络方式（例如适用平台的 host networking）。插件不自动修改容器网络，也不开放公网监听。

环境文件设置通用模型的服务商、服务地址、转接令牌和模型名 `dsh-default`。后续在插件内切换默认模型即可更新 `dsh-default` 的路由，无需再重启 Hindsight。DSH 必须持续运行。端口冲突时可在插件配置中修改 `port`，再重新生成环境文件并重启 Hindsight。

**配置优先级：**既有 `RETAIN_LLM_*`、`REFLECT_LLM_*` 等独立用途的环境配置仍然优先，不会被插件自动清除。若要让对应用途继承通用默认模型，应在原部署中移除相应覆盖后重启。

## 记忆库与内容管理

由嵌入的原生控制台提供，行为和权限与原站一致。插件不再重复实现记忆库列表或内容管理界面。

当前 Hindsight 将模型、服务商、地址和密钥作为服务级配置，不支持通过 Bank API 修改。用户已确认本版仅支持全局模型，不接入需要额外部署的 Python 请求扩展。模型从 DSH 删除或重命名后，网关调用明确失败，不会静默切换其他模型。

## 转接范围与验证

使用 DSH 原生 `llm.stream`，提供 Hindsight 使用的非流式 OpenAI Chat Completions 响应，支持文本、工具调用、生成上限、停止词、推理强度和 token 用量。当前不支持图片输入、流式 HTTP 响应、强制工具选择、多候选或 DSH 未提供的采样参数，收到这些参数会明确拒绝。

DSH 暂不提供原生 `response_format`。JSON 请求通过附加提示词，并在返回前执行 JSON 解析及 JSON Schema 校验；这不能保证模型首次生成成功，不符合格式时返回失败，由调用方决定是否重试。建议选择适合结构化输出和工具调用的模型。

```sh
npm test        # 后台与转接的自动化验证
npm run build  # 构建 DSH 安装产物
npx playwright install chromium  # 首次页面验收时需要
npx playwright install webkit   # WebKit 手机兼容验收时需要
npm run test:ui # 无界面验证自动登录、Cookie、原生导航与模型配置
npm run test:ui -- --real-console # 对本机真实控制台进行只读嵌入验收
npm run test:ui -- --real-console --phone # HTTPS 手机转发，禁止直连宿主原生端口
npm run test:ui -- --real-console --phone --webkit # WebKit 同场景验收
```

默认页面验收使用模拟 Hindsight 上游，真实控制台模式使用本机既有凭据；两者的 DSH 模型目录和按钮均为测试替身，不修改真实 Bank 或产生模型费用。手机模式使用临时 HTTPS 转发，模拟配对凭据替换及移除上游 Cookie，验证真实列表、记忆库详情导航和重新载入。浏览器以无界面模式运行，结束后关闭，截图输出到 `artifacts/`；这不是实体手机验收。
