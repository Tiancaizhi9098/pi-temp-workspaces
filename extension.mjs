import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkspaceManager, assertWorkspaceWrite, samePath } from "./manager.mjs";
import { janitorStatus, requestJanitorStop } from "./janitor.mjs";

export function startJanitor(manager) {
  const janitor = fileURLToPath(new URL("./janitor.mjs", import.meta.url));
  const child = spawn(process.execPath, [janitor, "--agent-dir", manager.agentDir, "--root", manager.root], {
    detached: true, windowsHide: true, stdio: "ignore",
    cwd: path.dirname(janitor),
  });
  child.on("error", (error) => {
    try {
      fs.appendFileSync(path.join(manager.state, "cleanup.log"), JSON.stringify({ time: new Date().toISOString(), error: `Background launch failed: ${error.message}` }) + "\n");
    } catch { /* A diagnostic failure must not interrupt the conversation. */ }
  });
  child.unref();
}

export function registerTempWorkspaces(pi, sdk, options = {}) {
  const hostAgentDir = sdk.getAgentDir();
  const manager = new WorkspaceManager({ agentDir: hostAgentDir, ...options });
  // Keep SDK configuration anchored to its original location after chdir().
  if (process.env.PI_CODING_AGENT_DIR && !path.isAbsolute(hostAgentDir)) {
    process.env.PI_CODING_AGENT_DIR = manager.agentDir;
  }
  let current = null;
  let release = null;
  let observeTimer = null;
  let startupError = null;
  let toolsInstalled = false;
  let processDirectory = null;

  const restoreProcessDirectory = () => {
    const previous = processDirectory;
    processDirectory = null;
    if (!previous) return;
    let actual;
    try { actual = process.cwd(); } catch { /* The OS may have removed the temporary folder. */ }
    if (actual && !samePath(actual, previous.workspace)) return;
    process.chdir(fs.existsSync(previous.cwd) ? previous.cwd : manager.home);
  };

  const notifyError = (ctx, error) => ctx.ui.notify(`临时工作目录：${error.message}`, "error");
  const updateWorkspaceTitle = ctx => {
    const record = current;
    if (!record) return;
    setImmediate(() => {
      if (current !== record) return;
      try {
        const name = ctx.sessionManager.getSessionName?.();
        ctx.ui.setTitle?.(`π${name ? ` - ${name}` : ""} - ${path.basename(manager.root)}`);
      } catch { /* Non-interactive hosts may not expose a terminal title. */ }
    });
  };
  const shellEnvironment = (record, env) => {
    const temp = path.join(record.workspace, ".tmp");
    const cache = path.join(record.workspace, ".cache");
    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    return {
      ...env, TEMP: temp, TMP: temp, TMPDIR: temp,
      npm_config_cache: path.join(cache, "npm"), PIP_CACHE_DIR: path.join(cache, "pip"),
      UV_CACHE_DIR: path.join(cache, "uv"), XDG_CACHE_HOME: cache,
      PYTHONPYCACHEPREFIX: path.join(cache, "pycache"),
      PI_TEMP_WORKSPACE: record.workspace,
    };
  };

  function installTools(ctx, record) {
    const active = pi.getActiveTools();
    const settings = pi.getSettings?.() ?? {};
    const cwd = record?.workspace ?? ctx.cwd;
    const spawnHook = record ? (spawnContext) => ({
      ...spawnContext, cwd: record.workspace,
      env: shellEnvironment(record, spawnContext.env),
    }) : undefined;
    const factories = [
      sdk.createReadToolDefinition, sdk.createWriteToolDefinition, sdk.createEditToolDefinition,
      sdk.createLsToolDefinition, sdk.createFindToolDefinition, sdk.createGrepToolDefinition,
      (cwd) => sdk.createBashToolDefinition(cwd, { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix, spawnHook }),
      (cwd) => sdk.createPowerShellToolDefinition(cwd, { spawnHook }),
    ];
    for (const factory of factories) {
      const tool = factory(cwd);
      const execute = tool.execute;
      const definition = { ...tool, defaultActive: active.includes(tool.name) };
      if (record) {
        definition.execute = async (callId, params, signal, onUpdate, toolContext) => {
          manager.validateFolder(record);
          if (tool.name === "write" || tool.name === "edit") assertWorkspaceWrite(record.workspace, params.path);
          // Pi's built-ins prefer ctx.cwd to the factory's fallback cwd.
          const scopedContext = Object.create(toolContext ?? ctx, {
            cwd: { value: record.workspace, enumerable: true },
          });
          return execute(callId, params, signal, onUpdate, scopedContext);
        };
      }
      pi.registerTool(definition);
    }
    pi.setActiveTools(active);
  }

  pi.on("session_start", (_event, ctx) => {
    clearInterval(observeTimer);
    observeTimer = null;
    try { restoreProcessDirectory(); } catch (error) { notifyError(ctx, error); }
    try { release?.(); } catch (error) { notifyError(ctx, error); }
    release = null;
    current = null;
    startupError = null;
    ctx.ui.setStatus("temp-workspace", undefined);
    const eligible = manager.eligible(ctx.cwd);
    // Prepare the parent directory on every load, including project sessions.
    // Activation is a separate decision and never redirects an ordinary project.
    try {
      manager.initialize();
      if (options.background !== false) startJanitor(manager);
    } catch (error) {
      startupError = error;
      notifyError(ctx, error);
      if (toolsInstalled && !eligible) installTools(ctx, null);
      toolsInstalled = false;
      return;
    }
    if (!eligible) {
      if (toolsInstalled) installTools(ctx, null);
      toolsInstalled = false;
      return;
    }
    try {
      const report = manager.sweep();
      if (report.errors.length) ctx.ui.notify(`有 ${report.errors.length} 个临时目录未能清理，已保留。`, "warning");
      current = manager.bind({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
      release = manager.acquire(current);
      processDirectory = { cwd: process.cwd(), workspace: current.workspace };
      process.chdir(current.workspace);
      observeTimer = setInterval(() => {
        try { if (current) manager.observe(current.key); } catch { /* Keep active work intact. */ }
      }, 3000);
      observeTimer.unref?.();
      installTools(ctx, current);
      toolsInstalled = true;
      updateWorkspaceTitle(ctx);
    } catch (error) {
      clearInterval(observeTimer);
      observeTimer = null;
      try { restoreProcessDirectory(); } catch { /* Preserve the original startup error. */ }
      try { release?.(); } catch { /* Preserve the original startup error. */ }
      release = null;
      current = null;
      startupError = error;
      notifyError(ctx, error);
    }
  });

  pi.on("session_info_changed", (_event, ctx) => updateWorkspaceTitle(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    if (startupError && manager.eligible(ctx.cwd)) throw startupError;
    if (!current) return;
    const root = current.workspace;
    event.systemPromptOptions.cwd = root;
    event.systemPromptOptions.sections["temporary_workspace"] = [
      `This is a disposable conversation workspace: ${root}`,
      "All generated files, scripts, downloads, screenshots, logs, outputs, and project dependencies belong inside this folder.",
      "The filesystem and shell tools resolve relative paths in this folder. Use its .tmp and .cache directories for temporary data and caches.",
      "Do not write to the user home, drive root, Desktop, Documents, other projects, or sibling conversation folders. Do not install global or --user packages or edit shell profiles/configuration unless the user explicitly requests that separate change.",
      "Reading user-specified source files and installed skills outside this folder is allowed. Copy inputs here before changing them.",
      "When using Playwriter or another external tool, explicitly save downloaded/generated files under this workspace too.",
      "Leave the .pi-temp-workspace.json ownership marker untouched.",
      "Files persist when Pi exits and when this conversation is resumed. Deleting its conversation also deletes this workspace after it is no longer in use.",
    ].join("\n");
  });

  pi.on("input", (_event, ctx) => {
    if (!current) return;
    const record = manager.get(current.key);
    if (record.seenSession && manager.sessionState(record) === "missing") {
      ctx.ui.notify("这个临时对话已被删除。请用 /new 新建对话，或退出 pi；原目录会在释放后自动清理。", "warning");
      return { action: "handled" };
    }
  });

  pi.on("user_bash", (_event, _ctx) => {
    if (!current) return;
    const record = current;
    const local = sdk.createLocalBashOperations({ shellPath: pi.getSettings?.().shellPath });
    return { operations: {
      exec(command, _cwd, execution) {
        manager.validateFolder(record);
        return local.exec(command, record.workspace, { ...execution, env: shellEnvironment(record, execution.env ?? process.env) });
      },
    } };
  });

  pi.on("agent_end", () => { if (current) manager.observe(current.key); });
  pi.on("session_shutdown", () => {
    clearInterval(observeTimer);
    observeTimer = null;
    try { restoreProcessDirectory(); }
    finally { try { release?.(); } finally { release = null; current = null; } }
  });

  pi.registerCommand("temp-work", {
    description: "查看临时目录与后台清理状态：/temp-work [status|cleanup|start|stop]",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (["cleanup", "start", "stop"].includes(command)) {
        try {
          manager.initialize();
          if (command === "start") {
            startJanitor(manager);
            ctx.ui.notify("已请求启动后台清理进程；/temp-work status 可查看状态。", "info");
            return;
          }
          if (command === "stop") {
            const requested = requestJanitorStop(manager.state);
            ctx.ui.notify(requested ? "已请求停止后台清理，将在 3 秒内生效；下次启动临时对话时会重新启动。" : "后台清理进程未启动。", "info");
            return;
          }
          const report = manager.sweep();
          ctx.ui.notify(`已清理 ${report.removed.length} 个；等待释放或确认删除 ${report.pending.length} 个；保留异常 ${report.errors.length} 个。`, report.errors.length ? "warning" : "info");
        } catch (error) { notifyError(ctx, error); }
        return;
      }
      if (command && command !== "status") {
        ctx.ui.notify("用法：/temp-work [status|cleanup|start|stop]", "info");
        return;
      }
      const status = janitorStatus(manager.state);
      const background = status.running === true ? `运行中（PID ${status.pid}）` : status.running === false ? "未运行" : "状态异常，请检查清理日志";
      const message = current
        ? `当前临时对话目录：\n${current.workspace}\nPi 进程当前目录：\n${process.cwd()}\n\n/new 新建独立目录；/resume 恢复原目录。删除会话后约 10–15 秒自动清理，正在使用的目录会等到退出或切换后再清理。`
        : `当前为普通项目对话，工作目录保持为 ${ctx.cwd}。\n${startupError ? `临时目录准备失败：${startupError.message}` : `临时父目录已准备：${manager.root}`}\n从用户主目录、盘符根目录、Windows 系统目录或该父目录启动 Pi 时，会启用临时会话。`;
      ctx.ui.notify(`${message}\n\n后台清理：${background}\n状态与日志：${manager.state}`, "info");
    },
  });

  return { manager, get current() { return current; } };
}
