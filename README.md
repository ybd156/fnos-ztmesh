# ZeroTier异地组网-虚拟局域网
---

## 安装

1. 飞牛 → **应用中心 → 手动安装**，按你的 NAS 架构选择对应安装包：
   - `ztmesh-x86_64.fpk`（x86-64 / Intel / AMD）
   - `ztmesh-arm.fpk`（arm64 / aarch64）
2. 安装向导中可填写要加入的 **16 位网络 ID**（可留空，之后在界面里加也行）。
3. 安装完成后 ZeroTier 服务会自动启动。若填了网络 ID，会在首次启动时自动加入。
4. 从**应用中心**打开「ZeroTier异地组网-虚拟局域网」卡片进入管理界面。

> 本应用**无需任何外部运行时**：管理后端已重构为 Go 单静态二进制（`bin/ztmesh-server`），
> 不再需要 Node 运行时，安装时也不会额外拉取任何依赖应用。
> `install_init` 会在安装前检测 `uname -m`，非对应架构设备会给出中文报错并中止。

### 管理界面入口与端口

| 入口 | 地址 | 说明 |
|---|---|---|
| 应用中心卡片 | `http://<NAS-IP>:13443`（iframe） | 应用中心按 `app/ui/config` 的端口入口打开，功能完整 |
| 统一网关（若已注册） | `/app/ztmesh` | 后端同样处理带前缀的请求；网关会附带 `X-Trim-Userid` 登录身份头 |
| 局域网直连 | `http://<NAS-IP>:13443` | 与卡片同一入口，方便收藏或脚本调用 |

服务端口统一为 **13443**（`manifest.service_port`、`app/ui/config` 与后端监听三处一致；
1.2.0 的 `cmd/main` 缺省写死 3443，是错配）。

「子网路由」页的 **显示 Token** 默认只回显掩码预览（如 `abcd••••wxyz`）。
完整令牌只下发给可信来源：经统一网关转发（带 `X-Trim-Userid`）、NAS 本机回环地址，
或 **本机所在的私有网段**（RFC1918 / 链路本地）。来自公网地址的请求一律只给掩码——
1.2.0 会把令牌返回给任何能连上端口的客户端，包括做了端口转发的公网访问。

### 重新安装（升级本包）

应用版本号遵循语义化版本规范（SemVer），从 **1.0.0** 起独立递增（不跟随内置 ZeroTier 版本），变更记录见 [CHANGELOG.md](CHANGELOG.md)；
安装与升级时都会记录到 `$TRIM_PKGVAR/VERSION`（升级路径以前漏写，会显示旧版本号）。
管理界面「概览 → 版本」同时显示 ZeroTier 版本与应用版本，应用版本由后端 `/api/ping` 自报，打包时从 manifest 注入。
如果应用中心因为版本相同而拒绝覆盖安装，**先卸载再安装**即可：卸载默认保留 `$TRIM_PKGVAR/zt`，
节点身份与已加入的网络不会丢（卸载向导里可选择「删除所有数据」彻底清除）。

万一卸载时选择了删除数据、导致节点地址变化，在新界面的「概览」里复制新的设备地址，
到 my.zerotier.com 的网络里重新勾选 **Auth** 授权即可。

## 首次组网

1. 打开管理界面 → **概览**，复制 **设备地址 (Node ID)**（形如 `a1b2c3d4e5`）。
2. 到 [my.zerotier.com](https://my.zerotier.com) 打开你的网络 → **Members**，把这个地址添加并勾选 **Auth**（授权）。
3. 回到界面即可看到 **已连接** 和分配到的 IP。

## 功能

| 界面位置 | 能力 |
|---|---|
| 概览 | 设备地址、在线状态、版本、已加入网络数；一键复制地址；快速加入网络 |
| 概览 → 网络状态与流量 | 每张 `zt*` 隧道网卡的地址与**实时收/发流量**（`/proc/net/dev` 计数），可手动刷新 |
| 概览 → **开机自启** | 开关 NAS 重启后自动拉起服务，显示当前生效的机制（systemd / cron）与错误原因 |
| 网络 | 网络列表（名称 / ID / 状态 / 类型 / MAC / 已分配 IP），顶部唯一的**加入网络**入口与**手动刷新** |
| 网络 → 每张卡片 | **接受网络路由**、**允许公网路由**、**全局 VPN 模式**、**使用网络 DNS** 四个开关（各带一句通俗说明）；**离开网络**独立置于卡片底部危险区，两步确认防误触 |
| 对端设备 | VL1 对端列表：地址、名称、角色、延迟、版本、**当前连接的所有物理 IP**（去重、可横向滚动），右上角**手动刷新** |
| **子网路由** | 把 NAS 所在的**物理局域网**共享给 ZeroTier 里的其他设备（一键自动配置）；API Token 默认隐藏，可点「显示」查看 |
| 侧栏 | 服务状态指示灯 + **启动/停止服务** |

「启动/停止服务」只控制 ZeroTier 守护进程，**不会**关闭管理界面本身（否则就再也点不回来了）；
点「停止服务」会在 `$TRIM_PKGVAR` 写下 `zt_disabled` 标志，**看门狗不会再把守护进程拉起来**，
下次点「启动服务」（界面调 `cmd/main zt-start`，等同 `cmd/main start`）会清除该标志。
整个应用的启停由飞牛应用中心负责（`ctl_stop=true`）。

**默认路由** 开启后所有流量走 ZeroTier；**网络 DNS** 用于让网络下发的 DNS 生效——异地组网、内网穿透、访问 NAS 内网服务时会用到这两个。

## 开机自启与看门狗

### 开机自启

- 机制：优先写 **systemd** unit `/etc/systemd/system/ztmesh.service`（`Type=oneshot` + `RemainAfterExit=yes`，
  开机执行 `cmd/main start`）；系统没有 systemd 时回退到 **cron** 的 `/etc/cron.d/ztmesh`（`@reboot` 行）。
- 状态记录在 `$TRIM_PKGVAR/autostart.conf`，界面「概览 → 开机自启」卡片会显示 `enabled` / 实际生效的 `mechanism`。
- 安装与升级时（`install_callback` / `upgrade_callback`）会自动安装或刷新自启项；卸载时（`uninstall_init`）会先移除。
- 界面开关对应接口：`GET /api/autostart` 查询、`POST /api/autostart`（`{"enabled":true|false}`）开关；
  也可以直接用命令行：`cmd/main autostart-enable|autostart-disable|autostart-status`。

### 看门狗

- 服务启动时会顺带拉起 `cmd/main supervise` 看门狗进程，每 **15 秒**检查一次：
  管理后端（`bin/ztmesh-server`）或 ZeroTier 守护进程掉线就自动重启。
- 同时巡检**子网路由是否完整**（每张网卡的 NAT/FORWARD、每条广播网段的策略路由）：
  开机时隧道网卡和物理网卡地址可能还没就绪，缺什么就重放什么，直到与 `subnet.conf` 一致——
  多网卡场景下不会出现「开机后只有部分规则生效」。
- 点界面上的「停止服务」写下 `zt_disabled` 后，看门狗**不会**再拉起守护进程，避免「点了停止又被拉起来」；
  该标志由 `cmd/main start`（界面走 `zt-start`）清除。
- 看门狗通过停止标志退出，不会在服务停止后残留。
- 健康检查接口：`GET /api/health` 返回 `{ok, web:{pid,uptime}, zt:{reachable,pid}, subnet:{enabled}}`，
  界面据此判断「进程在不在」以及「服务是不是真的可用」。

## 转发当前网段（子网路由）

ZeroTier 默认只能访问**装了 ZeroTier 的设备本身**。打开这个功能后，NAS 就成了一台
**子网路由器**：外面（比如公司、手机 4G）的设备能直接访问 NAS 所在局域网的**整段地址**
——同一网段里的打印机、路由器管理页、其他没装 ZeroTier 的机器都能连。

对应官网的 [Physical Network Routing (NAT/Masquerade)](https://docs.zerotier.com/route-between-phys-and-virt/)，
官方手动要四步（加托管路由 / 开 IP 转发 / 三条 iptables 规则 / 做持久化），这里点一下全部自动完成。

### 用法

1. 侧栏 **子网路由**。
2. **勾选一张或多张物理网卡**（界面已列出本机每张网卡及其网段，例如 `以太网 · 192.168.150.10/24`）。
3. **共享网段**按所勾网卡自动生成：每张网卡的网段**放宽一位**（`192.168.150.10/24` → `192.168.150.0/23`），
   **相同网段只生成一条**。这是官方建议：让**同时**能走本地网线的设备继续走本地，不绕 ZeroTier。
4. 选 **ZeroTier 网络**（需已授权，界面会显示该网络里本机的 `zt*` 地址）。
5. 填 **ZeroTier Central API Token** —— *仅当网络由 ZeroTier 官方控制器托管时需要*。
6. 点 **开启转发**。

### 关于 API Token

| 网络由谁托管 | 是否需要 Token |
|---|---|
| 本机自建控制器（`zerotier-one -p19993` 自己控制的网络） | **不需要**，应用直接调本地 `/controller/network/<nwid>` |
| ZeroTier 官方控制器（[my.zerotier.com](https://my.zerotier.com) 上建的网） | **需要**，用来往网络里写托管路由 |

- Token 在 my.zerotier.com → **Account → API Access Tokens** 创建。
- 令牌**只保存在 NAS 上**（`$TRIM_PKGVAR/central_token`，权限 `600`），列表类接口**不回显内容**；
  界面上只显示「已保存 / 未保存」。
- 在「开启子网路由」时填写的令牌会**一并保存**：关闭转发、停止服务和卸载都要用它撤销网络上的托管路由，
  1.2.0 只把它用一次就丢了，导致后来「关闭转发」撤不掉路由、网段对其他成员黑洞。
- `GET /api/subnet/token` 默认只返回掩码预览；完整内容仅下发给可信来源——经统一网关转发
  （带 `X-Trim-Userid`）、NAS 本机回环地址，或本机所在的**私有网段**。公网来源只拿得到掩码，
  界面会提示「完整内容仅在本机或局域网内可查看」。
  旧版 `api.zerotier.com/api/v1`（`token` 头）与新版 `central.zerotier.com/api/v2`（`Bearer` 头）**两种都支持**，自动探测。
- 会改动本机的接口（启动/停止守护进程、开关子网路由、保存令牌、开关自启）同样只接受可信来源，
  公网来源返回 `403 untrusted-origin` 并说明原因。

### 应用会做的四件事

1. **托管路由**：为每个**不同的物理网段**加一条 `Destination = 共享网段`、`Via = 本机 zt* 地址`
   的托管路由（会先读出已有路由**合并**后再写回，不会冲掉你手动加的路由）。
2. **IP 转发**：`net.ipv4.ip_forward=1`。
3. **策略路由修正**：fnOS 多网卡会配置源地址策略路由（`ip rule from <网卡IP> lookup route_<网卡>`，
   这些表只有默认路由）。NAS 用自己的局域网 IP 回包给隧道客户端时会被劫持到物理网关而丢弃。
   应用会把**所有经由 zt 网卡的目的网段**钉到主路由表（`ip rule add to <网段> lookup main pref 5`），
   关闭转发时移除。
4. **NAT 规则**：**对每张勾选的网卡分别**下发 `iptables -t nat -A POSTROUTING ! -s <该网卡本网段> -o <物理网卡> -j MASQUERADE`
   与对应的 `FORWARD` 放行规则。`! -s` 排除本网段——NAS 自己进出局域网的流量**绝不做源地址改写**，
   否则多网卡同网段时回包源地址被改掉，会导致**用 NAS 自己的 IP 访问不通**。全部用 `iptables -C` 先判断
   再插入，**幂等**，重复开启不会堆规则。

每次应用启动（含 NAS 重启后）都会按保存的配置**重新应用一次**本机规则，
因此**不需要**写 `/etc/sysctl.d` 或 `iptables-save`，不给系统留持久化痕迹。

### 多网卡（含两张网卡同网段）

- 界面会列出本机**所有**可共享的物理网卡（自动排除 `lo`、ZeroTier 网卡 `zt*`、
  Docker 网桥 `docker0`/`br-*` 等虚拟接口），可**同时勾选多张**。
- **每张网卡**各自下发一组 MASQUERADE + FORWARD 规则；任一网卡规则下发失败即整体中止并
  回滚，不会出现「只配上一半」的状态。
- **两张网卡接在同一个局域网**（例如双网口都在 `192.168.250.0/24`）也完全支持：
  两个接口都会做 NAT/转发，但同网段的**托管路由只登记一条**，设备从任一网口进来都能通。
- 状态页按网卡逐行显示 `nat_rule` / `forward_rules` 是否就位，最下面一行是汇总结果。
- 旧版本保存的 `PHY_IFACE`/`TARGET`（单网卡）配置会在读取时**自动迁移**为列表形式，无需手动改。

### 关闭与卸载

点 **关闭转发**（内联两步确认，不再弹浏览器 `confirm`）会按「先撤网络上的托管路由、再删本机规则」的顺序清理
（反过来会在这个网段上留下指向本机的路由，把整个网段对其他设备**黑洞化**）。

**停止服务、卸载应用时也会自动清理**本机的 NAT / FORWARD / 策略路由规则，不会把规则残留在系统里
（旧版 `stop` 只停进程不撤规则，NAS 关机重启前会一直残留）。
卸载时由 `uninstall_init` 先调 `ztmesh-server --subnet-withdraw` 撤离线托管路由，
再由 `cmd/main subnet-cleanup` 删本机规则——这一步必须在停服务之前做，因为要跟守护进程通话。

卸载向导提供两个选项：
- **保留数据**（默认）：只清理路由与规则，节点身份和已加入的网络完整保留，重新安装后自动恢复。
- **删除所有数据**：节点身份、API Token、子网路由配置一并清除，确保无残留。

### 已知限制（官方同样如此）

- 不转发广播/多播，所以**跨网段发现类**功能（mDNS、网上邻居自动发现）无效，需用 IP 直连。
- 局域网侧设备**无法主动**发起连接到外部 ZeroTier 客户端，只能被动接受访问。
- 需要目标网络里的成员设备把该网段的路由交给本机，即托管路由必须写成功；若写入后回读校验不通过，
  界面会**明确报错**而不会假装成功。
- 子网路由按 **IPv4** 工作：网络必须给本机分配 IPv4 地址。双栈网络即使本机先拿到 IPv6，
  应用也会**自动挑选 IPv4** 作为托管路由的经由地址（`via` 填 IPv6 的 IPv4 路由不会生效）。

## 数据与持久化

| 内容 | 位置 |
|---|---|
| 节点身份（`identity.secret`）、`authtoken.secret`、已加入网络 | `$TRIM_PKGVAR/zt`（= `/vol{n}/@appdata/ztmesh/zt`，重启保留） |
| Central API Token | `$TRIM_PKGVAR/central_token`（权限 `600`） |
| 子网路由配置 | `$TRIM_PKGVAR/subnet.conf`（权限 `600`，含网卡名/网段；**存在即代表转发处于开启状态**） |
| 子网路由日志 | `$TRIM_PKGVAR/subnet.log` |
| 开机自启状态 | `$TRIM_PKGVAR/autostart.conf`（`enabled` / `mechanism`） |
| 「停止服务」标志 | `$TRIM_PKGVAR/zt_disabled`（存在时看门狗不拉起守护进程；`zt-start` 清除） |
| 应用版本 | `$TRIM_PKGVAR/VERSION` |
| 运行 pid / 端口文件、日志 | `$TRIM_PKGTMP` |
| 程序与 Web 界面 | `$TRIM_APPDEST`（= `/vol{n}/@appcenter/ztmesh`），后端二进制为 `$TRIM_APPDEST/bin/ztmesh-server` |

`authtoken.secret` 只保存在后端，Web 界面通过后端（Go 服务）代理访问 ZeroTier API，**令牌不会下发到浏览器**；
Central API Token 也只在可信入口按需下发一次（见上文）。

**卸载默认保留节点身份和网络数据**，重新安装即恢复原身份；在卸载向导中选择「删除所有数据」才会彻底清除。

## 从源码构建

需要 **Go 1.21+**（本仓库在 `tools/go/bin/go` 放了 Windows 版工具链时可直接用）与 **Python 3.8+**。
管理后端的 Go 源码在 `server/`，打包脚本不再调用 `fnpack.exe`，纯 Python 直接生成 `.fpk`。

```bash
# x86-64 安装包 -> ztmesh-x86_64.fpk
python pack.py x86_64

# arm64 安装包 -> ztmesh-arm.fpk
#   仓库里只放了 x86-64 版守护进程，arm 构建前先取一份 arm64 的（一次性，约 10MB）
python scripts/fetch_zerotier_arm.py
python pack.py arm

# 不带参数等价于 x86_64
python pack.py
```

`scripts/fetch_zerotier_arm.py` 直接下载官方 `zerotier-one_<版本>_arm64.deb`，用标准库
（`tarfile` + `lzma`）解出 `usr/sbin/zerotier-one` 写到 `dl/zerotier-one.arm64`，
不依赖 `dpkg-deb`/`ar`/`xz`，Windows 上也能跑。

构建过程：

1. 交叉编译 `server/` → 临时目录中的 `app/bin/ztmesh-server`
   （`GOOS=linux`、`GOARCH=amd64|arm64`、`CGO_ENABLED=0`、`-trimpath -ldflags "-s -w"`）。
   二进制**不会**写进源码树。
2. arm 构建时，若存在 `dl/zerotier-one.arm64` 就用它临时替换 `fpk/app/zt/zerotier-one`，构建结束后还原为 x86-64 版本。
3. 生成内层 `app.tgz`（`app/` 目录树）与外层归档（`manifest`、`app.tgz`、`cmd/*`、`config/*`、`wizard/*`、`ICON*.PNG`），
   并把 `manifest.checksum` 写成 `md5(app.tgz)`。
4. 权限：目录 `0755`；`cmd/*`、`app/bin/ztmesh-server`、`app/zt/zerotier-one` 为 `0755`；其余 `0644`；属主统一 `root:root`。
5. 结束前把 `fpk/manifest` 的 `platform` 还原为 `x86`，源码树保持 canonical。

没有可用的 Go 工具链时，可以预置二进制回退：放到 `dl/ztmesh-server-x86_64`（或 `dl/ztmesh-server-arm`）；
两者都没有则脚本以中文报错退出（退出码 2）。

打包后校验（Node 仅用于校验脚本，运行时不依赖 Node）：

```bash
node verify_fpk.js ztmesh-x86_64.fpk
node verify_fpk.js ztmesh-arm.fpk
```

开发自测（可选，不随包发布）：`tests/smoke.py` 用两个桩服务（本地 ZeroTier API + ZeroTier Central）
驱动真实二进制，覆盖 30 项接口契约：

```bash
cd server && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o ../tests/ztmesh-server.exe .
cd .. && go build -o tests/stubcmd.exe tests/stubcmd/main.go
python tests/smoke.py
```

校验内容：包骨架与 `cmd/*` 可执行位、`bin/ztmesh-server` 与 `zt/zerotier-one` 的 ELF 头与 `e_machine`
（x86-64=62 / arm64=183）、`manifest.checksum == md5(app.tgz)`、`manifest.platform` 与包一致、
无 `install_dep_apps` 依赖、无遗留 Node 后端、无 `.pid`/`.sock`/令牌等运行时残留。
