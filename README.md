# 京东 CK 自动同步 - Loon 插件（青龙直连）

## 文件
- `plugin.lpx`：Loon 插件配置
- `jd_to_qinglong_loon.js`：远程 Request/Generic 脚本

## GitHub 部署
1. 新建一个 **Public** GitHub 仓库，例如 `jd-loon-qinglong`。
2. 将本目录的两个文件上传到仓库根目录，分支使用 `main`。
3. 打开 `plugin.lpx`，将两处 `你的GitHub用户名` 替换为你的 GitHub 用户名；`#!homepage` 也改成真实仓库地址。
4. 提交修改。
5. Loon 添加插件时使用：`https://raw.githubusercontent.com/你的GitHub用户名/jd-loon-qinglong/main/plugin.lpx`
6. 在插件参数界面填写青龙外网根地址、Client ID、Client Secret、设备标识，并按需打开下方开关。

## 开关说明

### App 捕获开关
- `捕获京东主App`：关闭后不处理主 App 请求，也不会暂存主 App 的 wskey。
- `捕获京东特价版`：关闭后不处理特价版请求，也不会暂存特价版的 wskey。

### 变量上传开关
- `主App-上传JD_COOKIE`：控制主 App 的 `pt_key` 是否写入青龙 `JD_COOKIE`。
- `主App-上传JD_WSCK`：控制主 App 的 `wskey` 是否写入青龙 `JD_WSCK`。
- `主App-写入jdUser.ini的wskey`：独立控制主 App 的 `wskey` 是否写入 `jdUser.ini` 的 `wskey=`。
- `特价版-上传JD_COOKIE`：控制特价版的 `pt_key` 是否写入青龙 `JD_COOKIE`。
- `特价版-写入jdUser.ini的jskey`：独立控制特价版的 `wskey` 是否写入 `jdUser.ini` 的 `jskey=`；特价版不会写入 `JD_WSCK`。

所有开关默认开启，以保持原项目原有行为。关闭某个上传开关只影响对应目标，不会阻止同一凭证写入其他已开启目标。例如主 App 只打开 `JD_WSCK`、关闭 INI 开关时，仍会单独更新 `JD_WSCK`。

## 重要
- `plugin.lpx` 和 JS 必须在同一个仓库根目录、`main` 分支；JS 文件名保持 `jd_to_qinglong_loon.js`。
- GitHub 仓库内不放青龙 Client Secret、Token 或京东 Cookie。
- 插件参数中的 Client Secret 会由 Loon 传给脚本运行时；不要截图或分享插件参数。
- 青龙域名建议使用 HTTPS。不要将青龙 5700 裸端口直接暴露公网。
- 添加插件后，插件自身已包含 Script 和 MitM 配置，不要再在主配置重复添加同样的 Request 规则或 MITM 域名。
- 需要 Loon 3.5.1 (983) 或更高版本以使用新版 Script 语法和插件参数。

## 当前已知限制
- 这是基于现有版本的开关改造；没有在你的 iPhone/Loon 和青龙实例上做端到端实测。
- 现有版本此前出现过青龙配置文件列表 API HTTP 401 的问题，本次开关改造没有修复该权限/API问题；若该问题仍存在，INI 写入仍会失败。
