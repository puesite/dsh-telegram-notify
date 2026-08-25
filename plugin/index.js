import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';

export const name = 'dsh-telegram-notify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, 'settings.json');
const STATS_PATH = join(__dirname, 'stats.json');

const WORK_RE = /(执行|运行|安装|卸载|删除|清理|创建|修改|编辑|移动|复制|重命名|下载|上传|部署|构建|测试|修复|整理|打开|关闭|启动|停止|搜索|查询|克隆|提交|推送|发布|写代码|写个程序|开发|配置|设置|检查|扫描|备份|还原|重启)/i;

function sessionIdOf(session) {
  try {
    return String(session?.id ?? session?.sessionId ?? '');
  } catch {
    return '';
  }
}

function shortText(v, max = 500) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function humanText(v, fallback = '未提供') {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v || fallback;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return (s && s !== '{}' && s !== '[]') ? s : fallback;
  } catch {
    return fallback;
  }
}

function unwrapRpc(res) {
  if (!res || typeof res !== 'object') return null;
  const inner = res.result && typeof res.result === 'object' ? res.result : res;
  return inner;
}

export function apply(ctx, config = {}) {
  const token = config.token || process.env.DSH_TG_TOKEN;
  const chatId = String(config.chatId || process.env.DSH_TG_CHAT_ID || '');
  const proxy = config.proxy || process.env.DSH_TG_PROXY || '';
  const chatEnabled = config.chatEnabled !== false;
  const telegramApproval = config.telegramApproval !== false;

  if (!token || !chatId) {
    ctx.logger?.warn?.('[dsh-telegram-notify] missing token/chatId, plugin disabled');
    return;
  }

  let apiRef = null;
  let modelServiceRef = null;
  let chatSessionId = null;
  let chatSessionReady = false;
  let chatBusy = false;
  let chatTimeout = null;
  let updateOffset = 0;
  let polling = false;
  const startTime = Math.floor(Date.now() / 1000);
  const pendingApprovals = new Map();
  const sessionMeta = new Map(); // sid -> { kind, label, task, lastResult, parentSessionId, childIndex }
  const childCounters = new Map(); // parentSessionId -> count

  const notify = {
    start: config.notifyStart !== false,
    complete: config.notifyComplete !== false,
    error: config.notifyError !== false,
    approval: config.notifyApproval !== false,
    progress: config.notifyProgress === true,
  };
  const status = {
    busy: false,
    task: '',
    currentTool: '',
    lastCompletedAt: null,
    lastError: null,
    lastCompletedSession: '',
  };

  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const stats = {
    date: todayKey(),
    firstStartedAt: Date.now(),
    completedTasks: 0,
    errors: 0,
    toolCalls: 0,
    approvals: 0,
  };

  const loadStats = () => {
    try {
      if (existsSync(STATS_PATH)) {
        const loaded = JSON.parse(readFileSync(STATS_PATH, 'utf8'));
        if (loaded.date === todayKey()) {
          Object.assign(stats, loaded);
        } else {
          stats.date = todayKey();
          stats.firstStartedAt = Date.now();
        }
      }
    } catch {
      /* ignore */
    }
  };
  const saveStats = () => {
    try {
      writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  };
  loadStats();
  saveStats();

  const loadSettings = () => {
    try {
      if (existsSync(SETTINGS_PATH)) {
        Object.assign(notify, JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));
      }
    } catch {
      /* ignore */
    }
  };
  const saveSettings = () => {
    try {
      writeFileSync(SETTINGS_PATH, JSON.stringify(notify, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  };
  loadSettings();

  const tgRequest = (method, params = {}) => {
    return new Promise((resolve) => {
      const url = `https://api.telegram.org/bot${token}/${method}`;
      const args = ['-s', '--max-time', '30'];
      if (proxy) args.push('-x', proxy);
      args.push('-G');
      for (const [key, value] of Object.entries(params)) {
        const encoded = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
        args.push('--data-urlencode', `${key}=${encoded}`);
      }
      args.push(url);
      execFile('curl', args, { windowsHide: true, timeout: 30000 }, (err, stdout) => {
        if (err) {
          ctx.logger?.warn?.(`[dsh-telegram-notify] ${method} failed: ${err.message}`);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          ctx.logger?.warn?.(`[dsh-telegram-notify] ${method} bad response`);
          resolve(null);
        }
      });
    });
  };

  const send = (text, toChatId = chatId, extra = {}) => {
    return tgRequest('sendMessage', { chat_id: toChatId, text, parse_mode: 'HTML', ...extra });
  };

  const sendSoon = (text) => {
    void send(text).catch(() => {});
  };

  const dailyReportEnabled = config.dailyReport !== false;
  const dailyReportTime = config.dailyReportTime || '23:30';
  let lastDailySentDate = '';
  const dailyTimer = setInterval(() => {
    if (!dailyReportEnabled) return;
    const now = new Date();
    const today = todayKey();
    const [h, m] = dailyReportTime.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const target = (Number.isFinite(h) ? h : 23) * 60 + (Number.isFinite(m) ? m : 30);
    if (cur >= target && lastDailySentDate !== today) {
      lastDailySentDate = today;
      void send(getDailyText());
    }
  }, 60000);
  ctx.effect(() => () => clearInterval(dailyTimer), 'dsh-telegram-notify:daily');

  const answerCallback = (callbackId, text) => {
    return tgRequest('answerCallbackQuery', { callback_query_id: callbackId, text });
  };

  const isWorkRequest = (text) => WORK_RE.test(text);

  const fmtTime = (ts) => {
    if (!ts) return '从未';
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  const fmtDuration = (ms) => {
    if (!ms || ms < 0) return '0 分钟';
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
    return `${minutes} 分钟`;
  };

  const getStatusText = () => {
    const active = [...sessionMeta.entries()].filter(([sid, m]) => sid !== chatSessionId && m.busy);
    const lines = [];
    lines.push(active.length > 0 ? `🟡 <b>DSH 正在工作中…（${active.length} 个任务）</b>` : '🟢 <b>DSH 当前空闲</b>');
    if (active.length > 0) {
      active.forEach(([sid, m], idx) => {
        const label = getAgentLabel(m);
        const task = humanText(m.task, '未提供任务名称');
        const tool = m.currentTool ? ` · <code>${esc(m.currentTool)}</code>` : '';
        lines.push(`${idx + 1}. ${label} · ${esc(shortText(task, 120))}${tool}`);
        lines.push(`   会话：<code>${esc(sid)}</code>`);
      });
    }
    lines.push(`⏱️ 最近完成：<code>${esc(fmtTime(status.lastCompletedAt))}</code>`);
    if (status.lastError) lines.push(`❌ 最近错误：${esc(shortText(status.lastError, 200))}`);
    lines.push(`🔔 通知状态：开始=${notify.start ? '✅' : '❌'}，完成=${notify.complete ? '✅' : '❌'}，错误=${notify.error ? '✅' : '❌'}，批准=${notify.approval ? '✅' : '❌'}，进度=${notify.progress ? '✅' : '❌'}`);
    return lines.join('\n');
  };

  const getStatsText = () => {
    const runMs = Date.now() - (stats.firstStartedAt || Date.now());
    const lines = [];
    lines.push('📊 <b>今日统计</b>');
    lines.push(`📅 日期：<code>${esc(stats.date)}</code>`);
    lines.push(`⏱️ 今日已运行：<b>${esc(fmtDuration(runMs))}</b>`);
    lines.push(`✅ 完成任务：<b>${stats.completedTasks}</b>`);
    lines.push(`🔧 工具调用：<b>${stats.toolCalls}</b>`);
    lines.push(`❌ 错误次数：<b>${stats.errors}</b>`);
    lines.push(`🔔 审批请求：<b>${stats.approvals}</b>`);
    return lines.join('\n');
  };

  const getDailyText = () => {
    const lines = [];
    lines.push('📅 <b>今日日报</b>');
    lines.push(`📆 日期：<code>${esc(stats.date)}</code>`);
    lines.push(`⏱️ 今日已运行：<b>${esc(fmtDuration(Date.now() - (stats.firstStartedAt || Date.now())))}</b>`);
    lines.push(`✅ 完成任务：<b>${stats.completedTasks}</b>`);
    lines.push(`🔧 工具调用：<b>${stats.toolCalls}</b>`);
    lines.push(`❌ 错误次数：<b>${stats.errors}</b>`);
    lines.push(`🔔 审批请求：<b>${stats.approvals}</b>`);
    lines.push('');
    lines.push('辛苦啦，今天也继续加油喵～');
    return lines.join('\n');
  };

  const getMenuMarkup = () => ({
    inline_keyboard: [
      [
        { text: '📊 状态', callback_data: 'menu:status' },
        { text: '📈 统计', callback_data: 'menu:stats' },
      ],
      [
        { text: '📅 日报', callback_data: 'menu:daily' },
        { text: '💰 余额', callback_data: 'menu:token' },
      ],
      [
        { text: '🔔 通知开', callback_data: 'menu:notify-on' },
        { text: '🔕 通知关', callback_data: 'menu:notify-off' },
      ],
      [
        { text: '🆕 新对话', callback_data: 'menu:new' },
        { text: '❓ 帮助', callback_data: 'menu:help' },
      ],
    ],
  });

  const queryBalance = (apiKey) => {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.deepseek.com',
        path: '/user/balance',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  };

  const getBalanceText = async () => {
    const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
    const credPath = join(dshHome, '.credentials.yaml');
    let apiKey = '';
    try {
      const raw = readFileSync(credPath, 'utf8');
      const m = raw.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/);
      if (m) apiKey = m[1];
    } catch {
      apiKey = '';
    }
    if (!apiKey) {
      return '❌ <b>未找到 DEEPSEEK_API_KEY</b>，请先在 EAC 里配置。';
    }
    const data = await queryBalance(apiKey);
    if (!data) {
      return '❌ <b>查询余额失败</b>，可能是网络或 API 问题。';
    }
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    if (infos.length === 0) {
      return `ℹ️ 余额接口已返回，但暂无余额信息。\n可用：${data.is_available ? '✅' : '❌'}`;
    }
    const lines = infos.map((b) => {
      const cur = b.currency || 'CNY';
      const total = b.total_balance ?? '?';
      const granted = b.granted_balance ?? '?';
      const topped = b.topped_up_balance ?? '?';
      return `💰 ${cur} 总额：${total}\n  赠送：${granted}\n  充值：${topped}`;
    });
    return `📊 DeepSeek 余额\n${lines.join('\n')}\n可用：${data.is_available ? '✅' : '❌'}`;
  };

  const ensureMeta = (session) => {
    const sid = sessionIdOf(session);
    if (!sid) return null;
    let meta = sessionMeta.get(sid);
    if (!meta) {
      const isSub = session?.header?.origin === 'subagent';
      const parent = session?.header?.parentSession;
      let childIndex = null;
      if (isSub && parent) {
        childIndex = (childCounters.get(parent) || 0) + 1;
        childCounters.set(parent, childIndex);
      }
      meta = {
        kind: isSub ? 'subagent' : 'main',
        label: '',
        task: '',
        currentTool: '',
        lastResult: '',
        parentSessionId: parent || '',
        childIndex,
        busy: false,
      };
      sessionMeta.set(sid, meta);
    }
    return meta;
  };

  const getAgentLabel = (meta) => {
    if (!meta || meta.kind !== 'subagent') return '🤖 主 Agent';
    const base = meta.childIndex ? `🧩 子 Agent #${meta.childIndex}` : '🧩 子 Agent';
    return meta.label ? `${base} · ${humanText(meta.label)}` : base;
  };

  const taskNameOf = (meta) => humanText(meta?.task, '未提供任务名称');
  const resultSummaryOf = (meta) => humanText(meta?.lastResult, '未提供结果摘要');

  const recomputeBusy = () => {
    const active = [...sessionMeta.entries()].filter(([sid, m]) => sid !== chatSessionId && m.busy);
    status.busy = active.length > 0;
    if (active.length === 0) {
      status.task = '';
      status.currentTool = '';
    } else if (active.length === 1) {
      const [, m] = active[0];
      status.task = m.task || status.task;
      status.currentTool = m.currentTool || '';
    } else {
      status.task = `${active.length} 个任务并行中`;
      status.currentTool = '';
    }
    return active;
  };

  const summarizeTask = async (sid, meta) => {
    try {
      const taskRaw = humanText(meta?.task, '');
      const resultRaw = humanText(meta?.lastResult, '');
      if (!taskRaw && !resultRaw) return null;
      if (!ctx.llm || typeof ctx.llm.stream !== 'function') return null;

      let provider = config.summaryProvider;
      let model = config.summaryModel;
      if ((!provider || !model) && modelServiceRef && typeof modelServiceRef.currentSelection === 'function') {
        const sel = modelServiceRef.currentSelection();
        if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
          provider = provider || sel.provider;
          model = model || sel.model;
        }
      }
      if (!provider || !model) return null;

      const input = [
        taskRaw ? `任务上下文：${taskRaw}` : '',
        resultRaw ? `结果上下文：${resultRaw}` : '',
        `会话：${sid}`,
      ].filter(Boolean).join('\n');

      const system = [
        '你是 DSH 工作通知摘要助手。',
        '根据上下文生成简洁、人类可读的任务名称和结果摘要。',
        '严格按以下两行输出，不要多余内容、不要引号：',
        '任务：<20字以内>',
        '结果：<50字以内>',
      ].join('\n');

      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: `请总结以下工作：\n${input}` }],
      }];

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      let text = '';
      try {
        for await (const chunk of ctx.llm.stream({
          provider,
          model,
          messages,
          system,
          maxTokens: 120,
          sessionId: sid,
          purpose: 'telegram-notify-summary',
          signal: ac.signal,
        })) {
          if (chunk?.type === 'text-delta') text += chunk.text || '';
          if (chunk?.type === 'finish') break;
        }
      } finally {
        clearTimeout(timer);
      }

      const taskMatch = text.match(/任务[：:]\s*(.+)/);
      const resultMatch = text.match(/结果[：:]\s*(.+)/);
      const task = taskMatch ? taskMatch[1].trim() : '';
      const result = resultMatch ? resultMatch[1].trim() : '';
      if (!task && !result) return null;
      return {
        task: task || humanText(meta?.task, '未提供任务名称'),
        result: result || humanText(meta?.lastResult, '未提供结果摘要'),
      };
    } catch {
      return null;
    }
  };

  async function ensureChatSession() {
    if (apiRef && chatSessionId && chatSessionReady) return chatSessionId;
    if (!apiRef) throw new Error('DSH apiProxy 不可用');
    const sessionId = chatSessionId || `telegram-${chatId}`;
    const res = await apiRef.sessions.create({
      rpcId: `tg-create-${Date.now()}`,
      payload: {
        sessionId,
        agentPreset: 'chat-only',
        cwd: 'C:\\Users\\hp\\Desktop',
      },
    });
    const inner = unwrapRpc(res);
    if (!inner?.ok) {
      const errMsg = inner?.error?.message || 'create session failed';
      throw new Error(errMsg);
    }
    chatSessionId = String(inner?.value?.sessionId ?? inner?.sessionId ?? sessionId);
    chatSessionReady = true;
    return chatSessionId;
  }

  async function sendChatReply() {
    if (!apiRef || !chatSessionId) return;
    try {
      const res = await apiRef.sessions.history({
        rpcId: `tg-history-${Date.now()}`,
        payload: { sessionId: chatSessionId },
      });
      const inner = unwrapRpc(res);
      const events = inner?.value?.events ?? inner?.events ?? [];
      let reply = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]?.event ?? events[i];
        if (ev?.type === 'assistant/message') {
          const content = ev?.data?.message?.content ?? [];
          const texts = content.filter(c => c?.type === 'text').map(c => c.text).filter(Boolean);
          if (texts.length > 0) {
            reply = texts.join('\n');
            break;
          }
        }
      }
      if (!reply) reply = '（没有文本回复）';
      await send(reply);
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-telegram-notify] chat reply failed: ${e?.message ?? e}`);
      await send('回复获取失败，请稍后再试。');
    } finally {
      chatBusy = false;
      if (chatTimeout) { clearTimeout(chatTimeout); chatTimeout = null; }
    }
  }

  async function handleMessage(msg) {
    const text = (msg.text || '').trim();
    if (!text) return;

    if (text === '/start' || text === '/help' || text === '帮助') {
      await send(
        '🐱 <b>Mocha 猫娘助手</b>\n\n在这里可以和我聊天，也可以管理 DSH 通知。\n\n⚠️ 工作请在桌面端 EAC 发布，我不能在 Telegram 里执行工作。\n\n<b>可用命令：</b>\n/status - 查看 DSH 状态\n/stats - 今日统计\n/daily - 今日日报\n/menu - 打开主菜单\n/notify on|off - 开关通知\n/token - 查询 DeepSeek 余额\n/new - 开启新对话\n/help - 帮助',
        chatId,
        { reply_markup: getMenuMarkup() }
      );
      return;
    }

    if (text === '/menu') {
      await send('📱 <b>请选择功能：</b>', chatId, { reply_markup: getMenuMarkup() });
      return;
    }

    if (text === '/status') {
      await send(getStatusText());
      return;
    }

    if (text === '/stats') {
      await send(getStatsText());
      return;
    }

    if (text === '/daily') {
      await send(getDailyText());
      return;
    }

    if (text === '/notify' || text.startsWith('/notify ')) {
      const arg = text.replace('/notify', '').trim().toLowerCase();
      if (arg === 'on') {
        notify.start = notify.complete = notify.error = notify.approval = notify.progress = true;
        saveSettings();
        await send('🔔 <b>已开启全部通知。</b>');
      } else if (arg === 'off') {
        notify.start = notify.complete = notify.error = notify.approval = notify.progress = false;
        saveSettings();
        await send('🔕 <b>已关闭全部通知。</b>');
      } else if (arg === 'status' || arg === '') {
        await send(`🔔 <b>当前通知状态：</b>\n完成=${notify.complete ? '✅' : '❌'}\n错误=${notify.error ? '✅' : '❌'}\n批准=${notify.approval ? '✅' : '❌'}\n进度=${notify.progress ? '✅' : '❌'}`);
      } else {
        await send('用法：<code>/notify on</code> 或 <code>/notify off</code> 或 <code>/notify status</code>');
      }
      return;
    }

    if (text === '/token') {
      await send(await getBalanceText());
      return;
    }

    if (text === '/new') {
      chatSessionId = `telegram-${chatId}-${Date.now()}`;
      chatSessionReady = false;
      try {
        await ensureChatSession();
        await send('🆕 <b>已开启一段新的聊天～</b>');
      } catch (e) {
        await send('新对话创建失败：' + (e?.message ?? e));
      }
      return;
    }

    if (isWorkRequest(text)) {
      await send('这是工作请求哦，请到桌面端 EAC 发布工作喵～');
      return;
    }

    if (chatBusy) {
      await send('我还在回复上一条，请稍等一下喵～');
      return;
    }

    chatBusy = true;
    chatTimeout = setTimeout(() => {
      if (chatBusy) {
        chatBusy = false;
        chatTimeout = null;
        void send('回复超时了，请再试一次喵～');
      }
    }, 120000);

    try {
      const sessionId = await ensureChatSession();
      await tgRequest('sendChatAction', { chat_id: chatId, action: 'typing' });
      const res = await apiRef.sessions.prompt({
        rpcId: `tg-prompt-${Date.now()}`,
        payload: {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      });
      const inner = unwrapRpc(res);
      if (!inner?.ok) {
        throw new Error(inner?.error?.message || 'prompt not accepted');
      }
    } catch (e) {
      chatBusy = false;
      if (chatTimeout) { clearTimeout(chatTimeout); chatTimeout = null; }
      await send('发送失败：' + (e?.message ?? e));
    }
  }

  async function handleCallback(cq) {
    if (!cq || !cq.data || !cq.id) return;
    if (String(cq.from.id) !== chatId) {
      await answerCallback(cq.id, '无权操作');
      return;
    }
    const data = String(cq.data);
    if (data.startsWith('menu:')) {
      const key = data.slice(5);
      if (key === 'status') {
        await answerCallback(cq.id, '状态');
        await send(getStatusText(), chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'stats') {
        await answerCallback(cq.id, '统计');
        await send(getStatsText(), chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'daily') {
        await answerCallback(cq.id, '日报');
        await send(getDailyText(), chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'token') {
        await answerCallback(cq.id, '余额');
        await send(await getBalanceText(), chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'notify-on') {
        notify.start = notify.complete = notify.error = notify.approval = notify.progress = true;
        saveSettings();
        await answerCallback(cq.id, '已开启通知');
        await send('🔔 <b>已开启全部通知。</b>', chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'notify-off') {
        notify.start = notify.complete = notify.error = notify.approval = notify.progress = false;
        saveSettings();
        await answerCallback(cq.id, '已关闭通知');
        await send('🔕 <b>已关闭全部通知。</b>', chatId, { reply_markup: getMenuMarkup() });
      } else if (key === 'new') {
        chatSessionId = `telegram-${chatId}-${Date.now()}`;
        chatSessionReady = false;
        await answerCallback(cq.id, '新对话');
        try {
          await ensureChatSession();
          await send('🆕 <b>已开启一段新的聊天～</b>', chatId, { reply_markup: getMenuMarkup() });
        } catch (e) {
          await send('新对话创建失败：' + (e?.message ?? e), chatId, { reply_markup: getMenuMarkup() });
        }
      } else {
        await answerCallback(cq.id, '帮助');
        await send('🐱 <b>Mocha 猫娘助手</b>\n\n/status - 状态\n/stats - 统计\n/daily - 日报\n/notify on|off - 通知\n/token - 余额\n/new - 新对话', chatId, { reply_markup: getMenuMarkup() });
      }
      return;
    }

    const [action, approvalToken] = data.split(':');
    const pending = pendingApprovals.get(approvalToken);
    if (!pending) {
      await answerCallback(cq.id, '请求已过期或已被处理');
      return;
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(approvalToken);
    const outcome = action === 'approve' ? 'allowed-once' : 'rejected';
    pending.resolve(outcome);
    await answerCallback(cq.id, action === 'approve' ? '✅ 已批准' : '❌ 已拒绝');
    await send(action === 'approve' ? '✅ <b>已批准该请求。</b>' : '❌ <b>已拒绝该请求。</b>');
  }

  async function pollTelegram() {
    if (polling) return;
    polling = true;
    try {
      const res = await tgRequest('getUpdates', { timeout: 5, offset: updateOffset });
      if (res?.ok) {
        for (const update of (res.result || [])) {
          updateOffset = Math.max(updateOffset, Number(update.update_id) + 1);
          if (update.callback_query) {
            void handleCallback(update.callback_query);
            continue;
          }
          const msg = update.message || update.edited_message;
          if (!msg || !msg.text) continue;
          if (String(msg.chat.id) !== chatId) continue;
          if (Number(msg.date) < startTime - 120) continue;
          void handleMessage(msg);
        }
      }
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-telegram-notify] poll error: ${e?.message ?? e}`);
    } finally {
      polling = false;
    }
  }

  async function onEvent(session, event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    const sid = sessionIdOf(session);
    const meta = ensureMeta(session);

    try {
      if (event.type === 'turn/start') {
        if (meta) meta.busy = true;
        recomputeBusy();
        if (sid && sid !== chatSessionId && notify.start) {
          const label = getAgentLabel(meta);
          const task = meta?.task ? `\n任务：${esc(humanText(meta.task))}` : '';
          sendSoon(`🚀 ${label} · 开始工作${task}\n${sid ? `会话：<code>${esc(sid)}</code>` : ''}`);
        }
        return;
      }

      if (event.type === 'subagent/descriptor') {
        if (meta) {
          meta.kind = 'subagent';
          meta.label = humanText(event.data?.label || event.data?.provider || '');
          if (session?.header?.parentSession) meta.parentSessionId = String(session.header.parentSession);
        }
        return;
      }

      if (event.type === 'assistant/message') {
        if (meta) {
          const content = event.data?.message?.content ?? [];
          const texts = content.filter(c => c?.type === 'text').map(c => c.text).filter(Boolean);
          if (texts.length > 0) meta.lastResult = texts.join('\n');
        }
        return;
      }

      if (event.type === 'todo/write') {
        const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
        const current = todos.find(t => t?.status === 'in_progress') || todos.find(t => t?.status === 'pending');
        if (current?.content) {
          if (meta) {
            meta.task = String(current.content);
            recomputeBusy();
          } else {
            status.task = String(current.content);
          }
        }
        if (notify.progress) {
          const done = todos.filter(t => t?.status === 'completed').length;
          const total = todos.length;
          sendSoon(`📋 <b>进度更新：</b>${done}/${total}\n\n${sid ? `会话：<code>${esc(sid)}</code>` : ''}`);
        }
        return;
      }

      if (event.type === 'tool/call') {
        const toolName = event.data?.name ?? event.data?.tool ?? 'tool';
        if (meta) {
          meta.currentTool = toolName;
          recomputeBusy();
        } else {
          status.currentTool = toolName;
        }
        stats.toolCalls += 1;
        saveStats();
        return;
      }

      if (event.type === 'turn/end' && sid === chatSessionId && chatBusy) {
        if (meta) meta.busy = false;
        recomputeBusy();
        status.lastCompletedAt = Date.now();
        void sendChatReply();
        return;
      }

      if (event.type === 'approval/asked') {
        stats.approvals += 1;
        saveStats();
        if (notify.approval && !telegramApproval) {
          const data = event.data || {};
          const detail = humanText(data.detail ?? data.reason ?? data.description ?? data.text ?? '');
          sendSoon(`🔔 <b>需要你批准</b>\n\n${sid ? `会话：<code>${esc(sid)}</code>\n` : ''}详情：${esc(detail)}`);
        }
        return;
      }

      if (event.type === 'tool/result' && event.data?.error) {
        const err = event.data.error;
        const code = err?.code ? ` [${esc(humanText(err.code))}]` : '';
        const message = humanText(err?.message ?? err?.text ?? err, '未知错误');
        const tool = humanText(event.data?.name ?? event.data?.tool ?? 'tool', 'tool');
        status.lastError = `${tool}: ${message}`;
        stats.errors += 1;
        saveStats();
        if (notify.error) {
          const label = getAgentLabel(meta);
          sendSoon(`❌ <b>工具出错</b>${code}\n\n${label}\n工具：<code>${esc(tool)}</code>\n错误：${esc(message)}\n${sid ? `会话：<code>${esc(sid)}</code>` : ''}`);
        }
        return;
      }

      if (event.type === 'turn/end') {
        if (meta) meta.busy = false;
        recomputeBusy();
        status.lastCompletedAt = Date.now();
        status.lastCompletedSession = sid;
        if (sid === chatSessionId) return;
        stats.completedTasks += 1;
        saveStats();
        if (notify.complete) {
          const label = getAgentLabel(meta);
          const summary = await summarizeTask(sid, meta);
          const task = summary?.task || taskNameOf(meta);
          const result = summary?.result || resultSummaryOf(meta);
          const parentLine = meta?.parentSessionId ? `\n父任务：<code>${esc(meta.parentSessionId)}</code>` : '';
          sendSoon(`✅ ${label} · 工作完成\n任务：${esc(task)}\n结果：${esc(result)}\n会话：<code>${esc(sid)}</code>${parentLine}`);
        }
        return;
      }
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-telegram-notify] handler error: ${e?.message ?? e}`);
    }
  }

  ctx.on('session/event', onEvent);

  if (telegramApproval) {
    ctx.on('approval/request', (req, next) => {
      if (!req || typeof req !== 'object') return next();
      return new Promise((resolve) => {
        const approvalToken = randomUUID();
        const reason = req.reason ? `\n理由：${shortText(req.reason, 300)}` : '';
        const tool = req.toolName ? `\n工具：${req.toolName}` : '';
        const text = `🔔 <b>需要你批准</b>${tool}${reason}\n\n请选择：`;
        const replyMarkup = {
          inline_keyboard: [[
            { text: '✅ 批准', callback_data: `approve:${approvalToken}` },
            { text: '❌ 拒绝', callback_data: `reject:${approvalToken}` },
          ]],
        };
        const timer = setTimeout(() => {
          if (pendingApprovals.delete(approvalToken)) {
            resolve('rejected');
            void send('⏰ <b>批准请求超时，已自动拒绝。</b>');
          }
        }, 5 * 60 * 1000);
        pendingApprovals.set(approvalToken, { resolve, timer });
        void send(text, chatId, { reply_markup: replyMarkup }).then((res) => {
          if (!res?.ok) {
            clearTimeout(timer);
            pendingApprovals.delete(approvalToken);
            resolve('unavailable');
          }
        });
      });
    }, { prepend: true, global: true });
  }

  if (chatEnabled && typeof ctx.inject === 'function') {
    ctx.inject(['apiProxy', 'agentDefaultModel'], (apiCtx) => {
      apiRef = apiCtx.get('apiProxy') ?? null;
      modelServiceRef = apiCtx.get('agentDefaultModel') ?? null;
      if (!apiRef) {
        ctx.logger?.warn?.('[dsh-telegram-notify] apiProxy not injectable, chat disabled');
        return;
      }
      void ensureChatSession().catch((e) => {
        ctx.logger?.warn?.(`[dsh-telegram-notify] init chat session failed: ${e?.message ?? e}`);
      });
      const timer = setInterval(() => void pollTelegram(), 3000);
      ctx.effect(() => () => clearInterval(timer), 'dsh-telegram-notify:poll');
    });
  }
}