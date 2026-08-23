import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-telegram-notify';

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
  let chatSessionId = null;
  let chatSessionReady = false;
  let chatBusy = false;
  let chatTimeout = null;
  let updateOffset = 0;
  let polling = false;
  const startTime = Math.floor(Date.now() / 1000);
  const pendingApprovals = new Map();

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
    return tgRequest('sendMessage', { chat_id: toChatId, text, ...extra });
  };

  const sendSoon = (text) => {
    void send(text).catch(() => {});
  };

  const answerCallback = (callbackId, text) => {
    return tgRequest('answerCallbackQuery', { callback_query_id: callbackId, text });
  };

  const isWorkRequest = (text) => WORK_RE.test(text);

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
      await send('我是 Mocha 喵～\n\n在这里可以和我聊天。\n\n⚠️ 工作请在桌面端 EAC 发布，我不能在 Telegram 里执行工作。\n\n可用命令：\n/new - 开启新对话\n/help - 帮助');
      return;
    }

    if (text === '/new') {
      chatSessionId = `telegram-${chatId}-${Date.now()}`;
      chatSessionReady = false;
      try {
        await ensureChatSession();
        await send('已开启一段新的聊天～');
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
    const [action, approvalToken] = String(cq.data).split(':');
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
    await send(action === 'approve' ? '✅ 已批准该请求。' : '❌ 已拒绝该请求。');
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

  function onEvent(session, event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    const sid = sessionIdOf(session);

    try {
      if (event.type === 'turn/end' && sid === chatSessionId && chatBusy) {
        void sendChatReply();
        return;
      }

      if (event.type === 'approval/asked' && config.notifyApproval !== false && !telegramApproval) {
        const data = event.data || {};
        const detail = shortText(data.detail ?? data.reason ?? data.description ?? data.text ?? '');
        sendSoon(`🔔 需要你批准\n\n${sid ? `会话：${sid}\n` : ''}${detail ? `详情：${detail}` : '有一条新的批准请求'}`);
        return;
      }

      if (event.type === 'turn/end' && config.notifyComplete !== false) {
        if (sid === chatSessionId) return;
        const data = event.data || {};
        const reason = data.reason ? `（${data.reason}）` : '';
        sendSoon(`✅ 工作完成${reason}\n\n${sid ? `会话：${sid}` : ''}`);
        return;
      }

      if (event.type === 'tool/result' && event.data?.error && config.notifyError !== false) {
        const err = event.data.error;
        const code = err?.code ? ` [${err.code}]` : '';
        const message = err?.message ?? err?.text ?? shortText(err);
        const tool = event.data?.name ?? event.data?.tool ?? 'tool';
        sendSoon(`❌ 工具出错${code}\n\n工具：${tool}\n错误：${message}\n${sid ? `会话：${sid}` : ''}`);
        return;
      }

      if (event.type === 'todo/write' && config.notifyProgress === true) {
        const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
        const done = todos.filter(t => t?.status === 'completed').length;
        const total = todos.length;
        sendSoon(`📋 进度更新：${done}/${total}\n\n${sid ? `会话：${sid}` : ''}`);
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
        const text = `🔔 需要你批准${tool}${reason}\n\n请选择：`;
        const replyMarkup = {
          inline_keyboard: [[
            { text: '✅ 批准', callback_data: `approve:${approvalToken}` },
            { text: '❌ 拒绝', callback_data: `reject:${approvalToken}` },
          ]],
        };
        const timer = setTimeout(() => {
          if (pendingApprovals.delete(approvalToken)) {
            resolve('rejected');
            void send('⏰ 批准请求超时，已自动拒绝。');
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
    ctx.inject(['apiProxy'], (apiCtx) => {
      apiRef = apiCtx.get('apiProxy') ?? null;
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