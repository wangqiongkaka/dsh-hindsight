# DSH Hindsight 管理

DSH 插件：登录 Hindsight 控制台、读取记忆库、从 DSH 已有服务商模型中选择全局默认模型。不复制服务商密钥，不修改 Hindsight 源码，不接管现有部署。

## 安装

要求 Node.js 22+，DSH 宿主提供 `llm.listProviders`、`llm.listModels`、`llm.stream`、`webServer` 和插件配置页插槽。Hindsight 控制台需要支持 `/api/version`、访问密钥认证和 Bank 列表 API。本机 Hindsight 1.2.0 的接口已用于对照实现；其他版本请先确认兼容性。

```sh
npm install
npm test
npm run build
npm pack --ignore-scripts
```

在 DSH 插件管理器中安装生成的 `dsh-hindsight-0.1.0.tgz`，重新加载插件后打开它的配置页。也可以通过 DSH CLI 安装到指定 Profile：

```sh
dsh plugin --profile web add /absolute/path/dsh-hindsight-0.1.0.tgz
```

## 登录控制台

填写**控制台**地址（本机一般是 `http://localhost:9999`，不是 API 服务的 `8888`）和 `HINDSIGHT_CP_ACCESS_KEY`，点击登录。未启用控制台认证时密钥可留空。支持控制台部署路径，例如 `https://memory.example.com/hindsight`；远程地址必须使用 HTTPS。

插件仅在后台内存中保存控制台签发的会话，不保存访问密钥；插件重启或会话过期后需重新登录。退出会丢弃插件持有的会话，原生控制台浏览器会话独立。点击“打开原生控制台”进入原站，需使用原站自己的登录流程。不支持替代 SSO/OAuth 登录。

管理接口和模型转接仅允许本机访问。远程访问 DSH 的浏览器不支持本插件管理接口。

## 全局模型

在插件页面选择 DSH 已有模型，点击“保存默认模型并生成环境文件”。配置文件默认保存在 `<DSH_HOME>/dsh-hindsight/hindsight.env`，目录权限 `0700`、文件权限 `0600`，包含私有转接令牌，禁止提交到 Git 或分享。

首次接入时，让 Hindsight **服务进程**加载该环境文件，再按现有部署方式重启。文件生成不代表运行中的 Hindsight 已加载。对于直接运行的本机服务，可以在它的启动 shell 中使用：

```sh
set -a
. /absolute/path/to/dsh-hindsight/hindsight.env
set +a
# 在此 shell 中执行你现有的 Hindsight 启动命令。
```

Docker Compose 可在现有 Hindsight 服务中通过 `env_file` 引用该文件，然后由你重建服务。Compose 的显式 `environment` 会覆盖 `env_file` 中的同名字段，应检查冲突。修改 `.env` 或 `env_file` 后仅 `docker restart` 不会载入新环境。

**网络前提：**网关默认只监听 `127.0.0.1:18991`。Hindsight 必须能访问这个本机地址；容器的 `127.0.0.1` 指向容器自身，需自行采用可达主机回环地址的网络方式（例如适用平台的 host networking）。插件不自动修改容器网络，也不开放公网监听。连接远程控制台可以查看管理，但远程 Hindsight 调用本机网关需要你另行建立受保护的网络连接。

环境文件设置通用模型的服务商、服务地址、转接令牌和模型名 `dsh-default`。后续在插件内切换默认模型即可更新 `dsh-default` 的路由，无需再重启 Hindsight。DSH 必须持续运行。端口冲突时可在插件配置中修改 `port`，再重新生成环境文件并重启 Hindsight。

**配置优先级：**既有 `RETAIN_LLM_*`、`REFLECT_LLM_*` 等独立用途的环境配置仍然优先，不会被插件自动清除。若要让对应用途继承通用默认模型，应在原部署中移除相应覆盖后重启。

## 记忆库列表

登录后显示当前控制台可见的记忆库，支持刷新和完整分页读取。记忆库列表只读，创建、删除和内容管理请到原生控制台完成。

当前 Hindsight 将模型、服务商、地址和密钥作为服务级配置，不支持通过 Bank API 修改。用户已确认本版仅支持全局模型，不接入需要额外部署的 Python 请求扩展。模型从 DSH 删除或重命名后，网关调用明确失败，不会静默切换其他模型。

## 转接范围与验证

使用 DSH 原生 `llm.stream`，提供 Hindsight 使用的非流式 OpenAI Chat Completions 响应，支持文本、工具调用、生成上限、停止词、推理强度和 token 用量。当前不支持图片输入、流式 HTTP 响应、强制工具选择、多候选或 DSH 未提供的采样参数，收到这些参数会明确拒绝。

DSH 暂不提供原生 `response_format`。JSON 请求通过附加提示词，并在返回前执行 JSON 解析及 JSON Schema 校验；这不能保证模型首次生成成功，不符合格式时返回失败，由调用方决定是否重试。建议选择适合结构化输出和工具调用的模型。

```sh
npm test        # 后台与转接的自动化验证
npm run build  # 构建 DSH 安装产物
npx playwright install chromium  # 首次页面验收时需要
npm run test:ui # 无界面操作实际页面及后台，输出 artifacts/ 截图
```

页面验收使用示例模型与模拟 Hindsight 上游，DSH 按钮使用测试替身，不会修改真实 Bank 或产生模型费用。
