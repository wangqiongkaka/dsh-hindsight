# 实现与验收记录

## 已确认范围

- DSH“设置 → Hindsight”集中提供模型配置和原生控制台 iframe，原插件配置页不再重复显示；不再自建登录、退出、地址表单和记忆库列表。
- 后台复用本机环境变量或精确匹配控制台发布端口的 Docker 容器凭据，换取原生会话；原生 Cookie 只保留后台内存。通过继承 DSH 鉴权的同源代理支持桌面及已配对的手机入口，不要求浏览器直连宿主原生端口或转发原生 Cookie。密钥不进入 URL、JSON、页面或插件持久配置，不关闭原生认证。
- 通过 DSH 的 `llm.listProviders`、`listModels` 获取已有模型，使用 `llm.stream` 转接调用，不复制模型服务商密钥。
- 选择全局默认模型，保存私有配置并生成 `hindsight.env`；由用户加载到 Hindsight 服务并重启，插件不修改部署。
- 首次加载后，`dsh-default` 路由的后续模型切换由插件即时生效；DSH 需要持续运行。Docker 或远程 Hindsight 必须自行确保能访问本机回环网关。

## 被替代的决定

最初选择全局与 Bank 模型都支持。只读联调与源码核对发现，Hindsight 1.2.0 将模型及服务商归为服务字段，不允许 Bank API 写入。官方 `LLMRequestExtension` 可以按 Bank 路由，但需要额外部署 Python 扩展；用户随后明确选择只做全局配置。因此已删除 Bank 模型编辑、写入实现及对应模拟写入测试，未交付 Python 扩展。

用户最新要求精简页面并免密嵌入原生控制台，替代了自建访问密钥表单和只读 Bank 列表的决定。模型配置与其持久数据保留；记忆库及内容管理由 iframe 内的原生控制台提供。

## 0.1.3 迁移到设置与开发验收

- 用户确认将模型配置和原生控制台一起移到“设置 → Hindsight”，删除原插件配置页重复入口。页面、后台会话、模型路由及持久配置继续复用。
- `src/client.jsx` 改为正式注册 `settings.section`，分类 ID 为 `dsh-hindsight`。注册清理由 Cordis 生命周期管理；没有新增后台接口或依赖。
- `npm run test:ui` 及 `npm run test:ui -- --real-console --phone --webkit` 均通过。验收从真实 `apply` 注册的设置入口打开页面，验证模型保存/刷新、失败重试、原生导航、页面重开保持登录及手机 HTTPS 代理。设置容器、模型目录和 Button 仍是测试替身；WebKit 使用真实 Hindsight 只读数据。
- 桌面及 390px 手机截图已自行核对，见 `artifacts/console-embedded.png` 和 `artifacts/console-native-phone-webkit-mobile.png`。未在实体 iPhone 或真实 DSH 设置容器中截图。后台无改动，本次未重复运行后台单元测试，沿用 0.1.2 的 18 项验证结果。
- 已同步 `origin/main` 至 `708e631`，没有合并冲突；未要求提交或推送代码。

## 0.1.2 手机空白修复与开发验收

- 根因：0.1.1 的 iframe 指向 `127.0.0.1:9999`，手机请求的是手机自身；DSH 远程入口替换请求 Cookie 并移除响应 Cookie，原生 Cookie 不能沿该链路下发。
- 修复：注册 DSH 同源专用前缀，继承 `connection.authorizeIndex`，后台持有原生会话；不向原生控制台转发 DSH 凭据，不向浏览器返回原生 Cookie。资源、API 和跳转均走同源代理，API 数据不做文本替换。
- 原生 Next 未配置代理前缀，因此跨页面导航使用完整页面加载；Hindsight 1.2.0 的记忆库根路径正则增加代理前缀兼容。未修改原生源码、Docker 部署或认证配置。升级原生控制台后需重新验收此兼容。
- `npm test`：18 项通过，覆盖手机同源 URL、代理鉴权、Cookie 隔离、重定向、路径改写、编码记忆库 ID、读取续期一次且写入不重试，以及既有模型转接、私有配置和生命周期。
- `npm run test:ui`：通过，覆盖错误凭据与重试、原生导航、模型保存与刷新、刷新保持登录及外层窄屏溢出。
- Chromium、WebKit 的 `--real-console --phone` 模式均通过。使用临时 HTTPS 配对转发，替换请求 Cookie、去除响应 Cookie，并阻断浏览器直连原生端口，验证真实列表、进入编码 ID 的记忆库详情、重新载入和页面刷新。已自行核对 WebKit 的列表和详情截图，分别为 `artifacts/console-native-phone-webkit-mobile.png`、`artifacts/console-bank-phone-webkit.png`。
- 验收使用真实 Hindsight 只读数据；DSH 模型目录及 Button 使用测试替身，模型保存写入临时目录。未修改用户模型选择、真实 Bank、部署或调用付费模型。未在实体 iPhone 上测试。

## 0.1.1 开发阶段验证

以下是历史验证范围，未覆盖手机跨设备访问。0.1.1 返回宿主回环 URL，手机会访问自身的回环地址；同时远程入口会替换请求 Cookie 并移除响应 Cookie，原方案不能用于手机。0.1.2 改为已鉴权的同源代理，并兼容原生资源路径和完整页面导航，替代同主机、同协议浏览器限制。

- `npm test`：14 项通过。覆盖环境凭据优先、Docker 发布端口精确匹配、歧义/缺失凭据处理、移除旧接口、原生会话与安全 Cookie、跨站/Host/令牌校验、原有模型转接、环境文件权限、损坏配置保留及 Cordis 生命周期。
- 构建通过。新增认证代码未添加依赖。
- `npm run test:ui`：通过。无界面 Chromium 验证自动登录失败及重试、iframe 导航、模型保存/刷新不重置原生导航、HttpOnly Cookie 不可由页面脚本读取、页面刷新保持登录、390px 窄屏无外层横向溢出。
- `npm run test:ui -- --real-console`：通过。使用本机 Docker 中既有凭据免密进入真实原生控制台的 `/dashboard`，刷新后保持登录；没有出现密码输入框。截图为 `artifacts/console-native.png` 和 `console-native-mobile.png`，已自行核对。模型目录与 DSH Button 为测试替身，未修改真实 Bank、模型选择或部署，也未调用付费模型。
- 真实验收首轮曾因脚本等待 `<main>` 超时；截图和 DOM 确认已成功免密进入原生页面，而原生使用 `<div>` 布局。脚本改为等待实际“记忆库”标题后通过，未将那次超时记为产品认证错误。
- 已只读确认当前 DSH 宿主具备 Docker CLI 路径。原生控制台部署和认证配置保持原样。

## 0.1.0 历史开发验证

- `npm test`：12 项通过，覆盖登录错误与过期、分页、私有文件权限、损坏配置保留、来源/Host/令牌校验、默认模型切换、工具消息映射、JSON Schema 校验、截断状态，以及真实 Cordis 生命周期。
- `npm run build`：通过；构建产物可直接导入，配置默认值可解析。
- `npm run test:ui`：通过。无界面 Chromium 操作实际 React 页面与后台，DSH Button 和 Hindsight 上游使用测试替身；验证错误密钥、登录、全局保存、只读列表、退出、390px 窄屏无横向溢出。浏览器已关闭，截图见 `artifacts/`。
- 本机真实 Hindsight 控制台（`http://localhost:9999`，报告版本 1.2.0）：访问密钥登录成功，完整读取 12 个记忆库。仅临时保存会话并在验证后清理临时文件，未写入真实 Bank 或修改服务环境。
- 已自行核对桌面与窄屏截图，修复了窄屏“刷新”按钮折行；截图中仅含示例数据。

0.1.0 后续已通过当前桌面宿主的官方 `pluginManager.installBundle` 安装并热加载，返回 `application: applied`。结构化输出仍使用提示词加返回校验，当前 DSH 无原生 `response_format`，不保证模型首次生成成功。

早期需求记录两次因本机 PostgreSQL 共享内存不足（500）失败；本次免密嵌入需求已成功记录为 `kp-78e8235ae7f94678a8f5b8f3ec36d691`。该数据库环境问题不在本次修改范围内。
