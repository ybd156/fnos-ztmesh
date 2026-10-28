# 更新日志

本项目遵循[语义化版本控制规范](https://semver.org/lang/zh-CN/)（Semantic Versioning）：

- **主版本号（MAJOR）**：不兼容的重大变更
- **次版本号（MINOR）**：向后兼容的新功能
- **修订号（PATCH）**：向后兼容的问题修复

版本号在以下位置保持一致：`fpk/manifest`（version 字段）、本文件、`README.md`。

## [2.1.1] - 2026-10-28

修订号提升：只修问题，接口不变。

### 修复
- **应用中心报「端口被占用」导致完全无法启用**：manifest 的 `checkport=true` 会让 fnOS 在启动前
  预检查 13443，一旦被占用就直接拒绝启动，而这个端口最常见的占用者恰恰是应用自己上一次的
  进程残留（或 1.2.x 遗留的 node 后端）。现在：
  - manifest 改为 `checkport=false`，端口交给应用自己接管；
  - `cmd/main start` 先判断占用者是不是自己：是就清掉再启动（并写日志），不是才报
    「端口 13443 被其他程序占用（pid N：/path/to/exe）」，且**不会**先把守护进程拉起来；
  - `stop` 结束时也会扫一遍端口，清掉没进 pid 文件的残留实例；
  - 端口由 `ss` 查（`/proc/net/tcp` 兜底），不依赖 lsof。
- **多架构软链接导致 PID 判活永远失败**：`install_callback` 把 `bin/ztmesh-server` 软链到
  `bin/ztmesh-server-amd64`，而 `/proc/<pid>/exe` 报的是解析后的真实路径，
  `is_pid_alive`/`find_zt_pid` 只比对软链接路径 → 永远判定「进程不在」：
  看门狗会把健康的实例当掉线的反复重启（还会在启动过程中把自己杀掉），`status` 也永远返回 3。
  现在两种写法都认（`readlink -f` 解析后比对）。

## [2.1.0] - 2026-10-28

次版本号提升：单包多架构 + 应用内升级 ZeroTier 核心，向后兼容。

### 新增
- **单包多架构（唯一产物）**：`python pack.py` 只生成 `ztmesh-all.fpk`，manifest 写 `platform=all`，
  包内同时带 `bin/ztmesh-server-amd64|arm64` 与 `zt/zerotier-one-x86_64|aarch64`；
  不再提供 x86 / arm 两个独立安装包。`install_callback` 按 `uname -m` 软链接出本机要用的
  `bin/ztmesh-server` 与 `zt/zerotier-one`（省掉第二份 10MB 副本），`upgrade_callback` 也会重建链接
- **应用内升级 ZeroTier 核心**：概览页新增「ZeroTier 核心」卡片，可检查更新、一键升级、回滚。
  后端从 `download.zerotier.com` 取官方 `.deb`，Go 里解析 ar 容器、系统 `tar` 解出
  `usr/sbin/zerotier-one`，校验 ELF 架构后停守护进程 → 原子替换 → 重启；
  旧核心留在 `$TRIM_PKGVAR/zt-bin/zerotier-one.prev` 供回滚。新核心装到 `$TRIM_PKGVAR/zt-bin/`
  （不在应用目录），重装/升级应用不会覆盖，`cmd/main` 优先使用它
- 新接口：`GET /api/core`、`POST /api/core/update`、`POST /api/core/rollback`（后两者仅可信来源）
- manifest 维护者信息改为可点击链接：`maintainer=ybd156` +
  `maintainer_url=https://github.com/ybd156`，`distributor=fnos-ztmesh` +
  `distributor_url=https://github.com/ybd156/fnos-ztmesh`
- `verify_fpk.js` 支持多架构包：逐个校验四个二进制的 ELF `e_machine`
- 冒烟测试跨平台化（Windows 用 Go 桩程序、Linux/WSL 用 bash 桩脚本），新增核心检查/升级/回滚断言

### 修复
- **打包进 CRLF 导致应用起不来**：Windows 上编辑过的 `cmd/main` 带 CRLF，装到 Linux 后
  shebang 变成 `#!/bin/bash^M`，报 `bad interpreter: No such file or directory`，`cmd/main` 完全无法执行。
  打包时把所有文本成员统一转成 LF，自检阶段也会拦截含 CR 的 `cmd/*` 与 `manifest`
- 首次在界面升级核心时没有回滚点（旧逻辑只在「已有界面安装的核心」时才备份）→ 改为备份当前真正在跑的核心，
  第一次升级也能回滚到包内版本

## [2.0.1] - 2026-10-28

修订号提升：只包含 2.0.0 之后发现的问题修复，接口与包结构不变。

### 修复
- **多网卡开机后子网路由不生效**：`start` 时隧道网卡（`zt*`）还没出现，`ip -4 route show dev zt*` 为空，
  策略路由修正规则一条都写不出来；物理网卡还没拿到地址时也生不成 MASQUERADE 规则。
  看门狗原本只在「守护进程掉线重启」时重放规则，正常开机永远等不到 → 新增 `subnet_rules_complete` 巡检：
  每张网卡的 NAT/FORWARD、每条广播网段的 `ip rule ... lookup main` 缺什么补什么，开机后先密集检查、
  收敛后降到约每分钟一次；`start` 时还会先等隧道网卡出现（最多 20 秒）
- 升级走 `upgrade_callback` 时不写 `$TRIM_PKGVAR/VERSION`，显示的版本号停在旧值 → 升级回调也记录版本
- Go 二进制的自报版本硬编码在源码里，可能与 `manifest` 不一致 → 打包时用
  `-X main.version=<manifest version>` 注入，版本号只在 manifest 维护一处
- 概览「版本」卡片拆分为 **ZeroTier 版本** 与 **应用版本**，升级后能直接确认跑的是哪个版本

## [2.0.0] - 2026-10-28

主版本号提升：管理后端从 Node 重写为 Go 单静态二进制，**不再依赖 `nodejs_v22`**，包结构与运行方式发生不兼容变更。

### 重构
- 管理后端由 Node 22（`app/server/server.js` + `central.js`）重写为 **Go 1.21+ 单静态二进制**（源码 `server/`，包内 `app/bin/ztmesh-server`），`CGO_ENABLED=0` 交叉编译，无外部运行时依赖
- `manifest` 删除 `install_dep_apps=nodejs_v22`，安装时不再拉取任何依赖应用
- `cmd/main` 启动后端由 `node server.js` 改为直接执行 `$APPDEST/bin/ztmesh-server`
- 打包不再调用 Windows 专用的 `tools/fnpack.exe`：`pack.py` 用 Python `tarfile` 直接生成 `.fpk`（外层 `manifest`/`app.tgz`/`cmd`/`config`/`wizard`/`ICON*.PNG`），权限与属主一次写对（目录 0755、`cmd/*` 与两个二进制 0755、其余 0644、root:root），并在构建时交叉编译注入 `app/bin/ztmesh-server`
- `manifest.checksum` 直接写为最终 `app.tgz` 字节的 MD5；`platform` 按目标架构写入（x86_64→x86、arm→arm），构建结束还原为 `x86`
- 端口统一为 **13443**：`manifest.service_port`、`app/ui/config` 与后端监听三处一致；后端同时处理统一网关的 `/app/ztmesh` 前缀与裸端口两种入口，并继续在 `$TRIM_APPDEST/app.sock` 监听（网关可用时自动生效）
- `verify_fpk.js` 改为校验 `bin/ztmesh-server`（ELF 头与 `e_machine`：x86-64=62 / arm64=183）、`cmd/*` 可执行位、`manifest.checksum == md5(app.tgz)`、无 Node 后端残留、无运行时残留文件
- 移除 `fpk/app/server/**`（Node 后端源码不再进包）；卸载流程改为调用 `ztmesh-server --subnet-withdraw`

### 修复
- `cmd/main` 的 `TRIM_SERVICE_PORT` 缺省值写死 **3443**，与 `manifest` 的 13443 不一致，个别入口会连不上后端 → 统一缺省 13443
- `cmd/main` 在 `log()` 定义之前就调用 `log`，架构检查失败等分支会报 `log: not found` 而非可读错误 → 调整函数定义顺序
- `stop` 只停进程、不清理 NAT/FORWARD/策略路由规则，关机或停止服务后 iptables 规则一直残留在系统里 → `stop` 时按保存的配置回滚本机规则
- `GET /api/subnet/token` 无来源校验，**任何能连上 13443 的客户端**（包括做了端口转发的公网来源）都能读到 Central API Token → 改为只下发给可信来源（网关头 `X-Trim-Userid`、本机回环、本机私有网段），其余只给掩码预览 `tokenPreview` + `requiresGateway`
- 服务状态只看 PID 文件在不在，进程僵死、端口未监听也显示「运行中」 → `cmd/main status` 改为「PID 存活 + 可执行文件一致 + `ztmesh-server --health` 实际探测」三重判断，未运行返回 3（符合 fnOS 契约）
- PID 文件里的 PID 可能被系统复用给别的进程，按 PID 判活会误判「已在运行」而拒绝启动 → 不再单凭 PID 判断
- 前端 `#serviceControls`（启动/停止服务按钮）带 `style="display:none"` 且 JS 从不切换，按钮**永远不显示** → 由 `setServiceState` 控制显隐
- 子网路由「关闭转发」用浏览器 `confirm()`，与「离开网络」的内联两步确认不一致且可能被浏览器拦截 → 改为内联两步确认
- 网络页 `setInterval(refresh, 8000)` 在切到其他视图、页面隐藏时仍在轮询 → 仅在可见视图且页面未隐藏时轮询
- `/network` 请求失败时地址栏继续显示旧值 → 失败时置「—」并保留错误提示
- 请求进行中按钮未禁用，重复点击会并发下发 → 请求中禁用、结束后恢复
- 看门狗与开机自启缺失：后端崩溃或 NAS 重启后服务不会自动恢复 → 见下方「新增」
- 「开启子网路由」时填写的 API Token 用完即弃，未落盘；之后「关闭转发」/卸载拿不到令牌，撤不掉网络上的托管路由，整个网段对其他成员黑洞 → 开启时一并保存（`600`）
- `stop` 只停进程，不撤销网络上的托管路由，NAS 关机后路由仍指向死节点 → `stop` 先撤路由再停服务，`start` 通过 `--subnet-restore` 恢复
- 卸载顺序：先撤托管路由、再删本机规则、最后停服务（顺序反了会在网段上留下黑洞路由），并把自启注册一并移除
- 前端「显示 Token」在非可信来源下会静默失败 → 后端返回掩码预览 `tokenPreview`，界面给出可读提示
- 子网路由页会自动轮询并打断正在编辑的复选框/令牌输入框 → 该视图不再自动轮询
- 启动/停止服务、开关子网路由、保存令牌、开关自启等**改动机器的接口没有任何来源限制**，端口一旦暴露到公网即可被任意调用 → 统一加 `untrusted-origin` 校验（仅本机、局域网、网关头放行）

### 新增
- **开机自启**：优先写 systemd unit `/etc/systemd/system/ztmesh.service`（`Type=oneshot` + `RemainAfterExit=yes`），无 systemd 时回退 `/etc/cron.d/ztmesh` 的 `@reboot`；状态写入 `$TRIM_PKGVAR/autostart.conf`，安装/升级时自动刷新，卸载时移除
- **看门狗** `cmd/main supervise`：服务启动时拉起，15 秒轮询，管理后端或 ZeroTier 守护进程掉线自动重启；界面「停止服务」写入 `$TRIM_PKGVAR/zt_disabled` 后不再拉起，`zt-start` 清除该标志
- 新增 `cmd/main autostart-enable|autostart-disable|autostart-status` 与 `supervise` 子命令
- 新增接口 `GET/POST /api/autostart`、`GET /api/health`、`GET /api/ping`
- 新增 `ztmesh-server --health`（供 `cmd/main status` 探活，免去依赖 curl/wget）、`--subnet-withdraw`、`--subnet-restore`
- 开发用冒烟测试 `tests/smoke.py`：在开发机上用两个桩服务（本地 ZeroTier API + Central）驱动真实二进制，覆盖 30 项接口契约（不随包发布）
- 概览新增「开机自启」卡片：开关自启、显示实际生效的机制与失败原因
- 概览「版本」卡片拆分为 ZeroTier 版本 + 应用版本，升级后可直接确认跑的是哪个版本

## [1.2.0] - 2026-10-02

### 新增
- 多架构支持：分架构出包，提供 `ztmesh-x86_64.fpk`（x86-64）与 `ztmesh-arm.fpk`（arm64/aarch64）两个安装包；安装前按 `uname -m` 校验架构并给出中文报错（次版本号提升：向后兼容的新平台支持）
- `pack.py` 支持 `python pack.py [x86_64|arm]` 分架构打包，manifest 的 `platform` 字段随包写入

### 变更
- `verify_fpk.js` 按包名校验 ELF 架构（x86-64: e_machine=62 / arm64: e_machine=183）与 manifest platform 一致性

## [1.1.0] - 2026-10-02

### 新增
- 网络卡片新增「高级设置」可折叠模块：四个网络选项开关、复制网络 ID、离开网络均收纳其中，箭头图标随展开/收起旋转，内容区带高度与透明度过渡动画（次版本号提升：向后兼容的新功能）
- 子网路由页的 API Token 支持「显示/隐藏」切换，默认隐藏，用户可主动查看完整令牌
- 概览页新增「网络状态与流量」卡片：显示各 zt* 隧道网卡地址与实时收/发流量
- 网络页、对端页、流量卡片新增手动刷新按钮
- 卸载向导新增「保留数据 / 删除所有数据」选项

### 变更
- 「加入网络」入口整合为输入框旁唯一按钮，移除页头重复按钮
- 四个网络选项开关改为通俗文案并附可见说明
- 「离开网络」移至卡片底部独立危险区，浏览器全局确认弹窗替换为内联两步确认
- 对端设备的路径地址去重，并改为可横向滚动列表以完整展示长 IPv6 地址
- manifest 发布者字段修正为 fnOS 规范的 `distributor`

## [1.0.0] - 2026-10-02

### 新增
- 首个正式版本：ZeroTier One 1.16.2 打包为 fnOS 应用（内部标识 `ztmesh`，独立端口 19993）
- 中文 Web 管理界面：概览、网络、子网路由、对端设备四个视图
- 子网路由一键配置：托管路由登记、IP 转发、逐网卡 NAT/FORWARD 规则、fnOS 源地址策略路由修正
- 多物理网卡（含同网段双网卡）支持，旧单网卡配置自动迁移
