# Pi 临时对话工作目录

用于管理本机临时对话文件的 Pi 扩展。已在 Windows / PowerShell 7、Pi 1.5.0 / 1.5.2、Node.js 24 上验证，无新增第三方运行时依赖。

## 使用

安装时会自动准备 `%TEMP%\Pi-Work` 父目录。重开 Pi 或执行 `/reload` 时，插件会再次确保它存在，即使当前是普通项目目录也会准备父目录。禁用了 npm 安装脚本的环境仍会在首次加载插件时创建。

从用户主目录（如 `C:\Users\你的用户名`）、盘符根目录（如 `C:\`）、Windows 系统目录（如管理员终端常用的 `C:\Windows\System32`）或临时父目录启动时，扩展会为当前会话分配 `session-<标识>` 子目录，并将 **Pi 进程本身的当前目录**切换到该子目录。无需手动建目录或安装 PowerShell 启动脚本。在其他目录启动时，保留项目的原有工作目录，只准备临时父目录，不分配临时会话。

- 新启动的对话及 `/new`：各自获得独立目录。
- `/resume`、`pi -c`：同一对话继续使用原目录。
- `/fork` 和 `/clone`：新会话使用新目录，不复制旧目录中的文件。
- `/temp-work`：查看当前对话的完整目录。
- 底部不显示临时目录状态行。
- 临时模式的终端标题显示 `Pi-Work`；`/temp-work` 同时显示会话目录和进程实际当前目录。
- `/temp-work cleanup`：立即执行一次清理检查。删除确认等待时间及使用中的目录保护仍然生效。
- `/temp-work status`：查看后台清理是否运行、PID 及状态/日志目录；不带参数也会显示。
- `/temp-work stop` / `/temp-work start`：手动停止或启动清理进程。停止只影响清理，下一次启动临时对话会再次启动。
- 项目目录中的普通对话：保持 Pi 原有工具和目录行为。

Pi 的会话记录仍存放在其原来的全局会话库中，会话列表及原生页脚按实际启动目录归类和显示。模型看到的有效目录、文件工具和命令的默认目录是每个对话自己的子目录；可以用 `/temp-work` 查看。Windows 个人 GitHub 安装会配置 PowerShell 7 启动函数。在主目录、盘符根目录或系统目录直接输入 `pi`，Pi 在启动前就进入 `Pi-Work`，会话列表和原生页脚也归到该目录。

## 文件落点

扩展将 Pi 内置的 read、write、edit、ls、find、grep、bash、powershell 工具绑定到当前对话目录。write / edit 拒绝目录外写入及通过目录链接越界写入。read 可以读取用户指定的外部资料和已安装的技能。

Shell 的临时文件及常见 npm、pip、uv、Python 缓存重定向到会话目录的 `.tmp` / `.cache`。模型收到规则，要求把脚本、截图、下载和输出放在当前目录，避免全局安装和修改用户配置。

Shell、MCP 和其他扩展仍保留本机权限。外部工具的专用缓存和默认下载位置由其自身设置决定；模型会被要求显式选择当前会话目录。这个扩展用于管理临时文件落点。

## 删除与清理

从 Pi 的 `/resume` 列表删除对话，或者从 Magpie 的「对话」页面删除本机 Pi 对话，原 `.jsonl` 会话文件都会离开原位置。扩展据此检测删除。

- 每次启动临时会话都会启动或复用一个隐藏的 Node 清理进程。退出 Pi 后，它继续工作，直到 Windows 注销/重启或手动停止。
- 清理进程每 3 秒检查一次，确认会话持续缺失 10 秒后清理，通常在 10–15 秒内完成。
- 当前仍在 Pi 中打开的目录会等到退出或切换对话后清理。被占用的文件会重试。
- Windows 重启后，首次启动临时 Pi 会重新启动清理进程，并补清理以前删除的对话。
- 系统清空临时目录后，恢复仍有聊天记录的对话会重建空目录；系统已经删除的文件无法由扩展恢复。
- 关闭 Pi、切换对话和压缩上下文都不会删除仍有会话记录的目录。
- Magpie 删除的是本机 Pi 会话记录时，才能触发此清理。只隐藏网关使用记录不等于删除本机对话。
- 清理会删除该临时目录中的所有生成文件。Magpie 的回收站保存聊天记录，恢复聊天记录不会恢复已经清理的工作文件。

目录归属由插件状态和工作目录内的 `.pi-temp-workspace.json` 双重核验。只有扩展登记创建的 `session-<标识>` 目录可以被清理；原来 `Pi-Work` 根目录中的文件和普通项目文件不参与清理。不要修改归属标记。

## 安装和停止

Windows PowerShell 7 中运行这行命令，安装插件并立即在当前窗口启用 `pi` 启动函数。

```powershell
pi install git:github.com/Tiancaizhi9098/pi-temp-workspaces && . $PROFILE.CurrentUserAllHosts
```

之后直接输入 `pi`。新开的 PowerShell 7 窗口会自动加载该函数。若安装环境禁用了 npm 安装脚本，首次加载 Pi 扩展时会补配 profile，随后请新开 PowerShell 7 窗口。

其他 shell 可用 `pi install git:github.com/Tiancaizhi9098/pi-temp-workspaces` 安装插件。

或克隆仓库后安装：

```powershell
git clone https://github.com/Tiancaizhi9098/pi-temp-workspaces.git
Set-Location pi-temp-workspaces
pi install .
```

新开 Pi 或执行 `/reload`。曾经手动放置过 `~/.pi/agent/extensions/pi-temp-workspaces/` 的用户，应先退出 Pi、按下文停止旧清理进程并将旧扩展移出 `extensions`，再安装本仓库版本，避免重复加载。

更新时可再次执行上面的安装命令。Windows 个人 GitHub 安装会备份 PowerShell 7 的当前用户通用 profile，并在标记块中引用 Pi 配置目录下的 `shell/pi-temp-workspaces-start.ps1`。如需指定其他 profile 路径，可在安装前设置 `PI_TEMP_WORK_PROFILE`，并在当前窗口加载该文件。

项目内安装、源码开发和其他平台使用扩展内的临时目录功能。若从本地源码安装，也可以在插件目录手动执行 `pwsh -File ./scripts/install-powershell7.ps1` 配置 PowerShell 7。

移除启动配置时，在插件目录执行以下命令。若直接用 `pi remove` 移除 GitHub 插件，profile 中的存在性检查会自动停用启动函数。

```powershell
pwsh -File ./scripts/install-powershell7.ps1 -Uninstall
```

状态位于 `~/.pi/agent/state/pi-temp-workspaces/`。那里只保存目录归属、使用标记、进程信息和有大小上限的清理日志，不复制聊天内容。

可在启动 Pi 前用环境变量 `PI_TEMP_WORK_ROOT` 指定**绝对路径**作为临时父目录。PowerShell 启动器会使用该路径，各个父目录的状态和清理进程相互独立。配置了 `PI_CODING_AGENT_DIR` 时，状态随 Pi 的配置目录保存。`PI_TEMP_WORK_BACKGROUND=0` 可以关闭自动启动后台进程，仍可手动执行清理。默认保持隐藏运行。

停止后台清理进程（Windows PowerShell 7）：

```powershell
$piAgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi/agent' }
# 在本插件目录执行；通过 Pi 包安装时，也可以从克隆仓库的插件目录执行。
node ./janitor.mjs --agent-dir $piAgentDir --stop
# 检查后台状态
node ./janitor.mjs --agent-dir $piAgentDir --status
```

停用时先在 `/temp-work stop` 或上面的 Node 命令中停止清理，再退出使用中的 Pi。安装过启动目录配置的用户先运行 `-Uninstall`，再用 `pi remove git:github.com/Tiancaizhi9098/pi-temp-workspaces` 卸载；本地安装的用户在原克隆仓库中执行 `pi remove .`。手动安装的扩展可移出 `extensions`。已有对话和工作文件会保留；多个自定义父目录的后台进程需分别停止，Node 命令可附加 `--root <绝对路径>`。

异常清理会保留目录并记录在状态目录的 `cleanup.log` 中。`/temp-work status` 显示进程未运行时，可用 `/temp-work start` 重启；目录标记损坏时不要手动伪造标记，应先另行保存需要的文件。扩展会保留旧的损坏进程锁以便检查，并可在其超过 30 秒后重新启动清理进程。

## 开发验证

```powershell
node --test test/*.test.mjs
```

先在仓库根目录执行 `npm ci --ignore-scripts`，再执行 `npm test` 可包含真实 npm 安装生命周期测试。测试覆盖无历史配置的安装、用户主目录/盘符根目录/Windows 系统目录自动启用、项目目录保持、真实进程目录、新建/恢复、Pi 自动加载及实际 RPC 切换、真实文件/PowerShell 工具、后台清理和停止、Magpie 式会话移走、在用保护、损坏标记、外部路径、目录链接、占用失败重试、系统清空临时目录、自定义根目录及 PowerShell 安装/卸载。PowerShell 和系统目录测试在 Windows 上运行；Linux 运行其余测试，macOS 尚未验证。
