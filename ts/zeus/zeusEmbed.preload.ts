// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zeus 嵌入逻辑：与主进程通信的 IPC 推送（会话列表登录信息、头像、未读数、发送结果等）。
 * 单独定义便于后期优化与扩展，不散落在 background 各处。
 */
import { ipcRenderer } from 'electron';
import { getRawAvatarPath } from '../util/avatarUtils.preload.js';
import { SIGNAL_AVATAR_PATH } from '../types/SignalConversation.std.js';
import type { AvatarColorType } from '../types/Colors.std.js';
import { AvatarColorMap, AvatarColors } from '../types/Colors.std.js';
import { getInitials } from '../util/getInitials.std.js';
import { getIdentifierHash } from '../Crypto.node.js';
import { isAciString } from '../util/isAciString.std.js';
import { isGroup } from '../util/whatTypeOfConversation.dom.js';
import { readFileSync, existsSync } from 'node:fs';

/** 当前登录用户信息推送载荷 */
export type ZeusSignalUserChangedPayload = {
  e164?: string;
  title?: string;
  /** 用户头像本地绝对路径，主进程据此提供 zeus-avatar://appId 供前端展示 */
  avatarPath?: string;
  /** 无头像时按 Signal 规则生成的占位图（纯色 bg + fg 首字母，与 BetterAvatarBubble 一致）data URL，主进程写入临时文件后按 appId 提供 zeus-avatar */
  avatarDataUrl?: string;
};

const ZEUS_CHANNEL_USER_CHANGED = 'zeus-session-user-changed';
const ZEUS_CHANNEL_UNREAD = 'zeus-signal-unread';
const ZEUS_CHANNEL_CHAT_LIST = 'zeus-signal-chat-list';
const ZEUS_CHANNEL_SESSION_STATUS = 'zeus-session-status';
const ZEUS_CHANNEL_MESSAGE_SENT = 'zeus-tweb-message-sent';

const PLACEHOLDER_SIZE = 96;

/**
 * 按 Signal AvatarPreview / BetterAvatarBubble 规则：纯色背景 (bg) + 彩色首字母 (fg)。
 * 与 .AvatarPreview__avatar.BetterAvatarBubble--A150 等样式一致（background-color: var(--bg); color: var(--fg)）。
 */
function renderPlaceholderAvatarToDataUrl(bg: string, fg: string, initial: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = PLACEHOLDER_SIZE;
  canvas.height = PLACEHOLDER_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);

  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.ceil(PLACEHOLDER_SIZE * (32 / 56))}px system-ui, sans-serif`;
  ctx.fillText(initial, PLACEHOLDER_SIZE / 2, PLACEHOLDER_SIZE / 2);

  return canvas.toDataURL('image/png');
}

/** 供外部注入的存储接口（仅需 user.getNumber），避免依赖完整 itemStorage 类型 */
export type ZeusUserStorage = {
  user: { getNumber: () => string | undefined };
};

/**
 * 推送当前登录信息到主进程（会话列表用）。
 * 在 userChanged 与「已登录就绪」时各调用一次。
 * 无真实头像时按 Signal 规则生成占位图（与 BetterAvatarBubble 一致：纯色 bg + fg 首字母），转为 data URL 发送，主进程写入临时文件供 zeus-avatar 使用。
 * 只要发送用户信息就必定带上头像：有则发真实头像路径，没有则生成占位图并发送，确保主进程始终有图可展示。
 */
export function pushZeusUserInfo(storage: ZeusUserStorage): void {
  try {
    const e164 = storage.user.getNumber() ?? undefined;
    const ourConversation =
      window.ConversationController?.getOurConversation?.();
    const title = ourConversation?.getTitle?.() ?? '';
    let avatarPath: string | undefined;
    let avatarDataUrl: string | undefined;
    let placeholderHash: number | undefined;
    let placeholderInitial = '';

    let avatarColorKey: string | undefined;
    if (ourConversation?.attributes) {
      const attrs = ourConversation.attributes;
      const avatar = ourConversation.get('profileAvatar') || ourConversation.get('avatar');
      if (avatar?.path && avatar.path !== SIGNAL_AVATAR_PATH) {
        avatarPath = getRawAvatarPath(attrs);
      } else {
        avatarColorKey = ourConversation.getColor?.() ?? undefined;
        placeholderHash = getIdentifierHash({
          aci: isAciString(attrs.serviceId) ? attrs.serviceId : undefined,
          e164: attrs.e164,
          pni: attrs.pni,
          groupId: attrs.groupId,
        }) ?? 0;
        placeholderInitial = getInitials(title || (e164 ?? '')) ?? '';
      }
    } else if (e164 != null) {
      placeholderHash = 0;
      placeholderInitial = e164.slice(-2) || '?';
    }

    if (!avatarPath && (placeholderHash !== undefined || placeholderInitial || avatarColorKey)) {
      const initial = placeholderInitial || (e164 ? e164.slice(-1) : '?');
      const colorKey: AvatarColorType =
        (avatarColorKey ?? AvatarColors[Math.abs(placeholderHash ?? 0) % AvatarColors.length]) as AvatarColorType;
      const { bg, fg } = AvatarColorMap.get(colorKey) ?? { bg: '#d2d2dc', fg: '#4f4f6d' };
      avatarDataUrl = renderPlaceholderAvatarToDataUrl(bg, fg, initial);
    }

    if (e164 != null || title || avatarPath || avatarDataUrl) {
      ipcRenderer.send(ZEUS_CHANNEL_USER_CHANGED, {
        e164,
        title: title || undefined,
        avatarPath,
        avatarDataUrl,
      } as ZeusSignalUserChangedPayload);
      // 确保主进程标记为 ready，便于群发页拉取会话列表（requestChatListForAppId）
      ipcRenderer.send(ZEUS_CHANNEL_SESSION_STATUS, { status: 'ready' });
    }
  } catch (_) {}
}

/**
 * 推送当前未读消息数到主进程（会话列表左上角展示）。
 * 在 ConversationController.updateUnreadCount() 内调用。
 */
export function pushZeusUnreadCount(unreadCount: number): void {
  try {
    ipcRenderer.send(ZEUS_CHANNEL_UNREAD, { unreadCount });
  } catch (_) {}
}

/** 与主进程 friend-list:get 对齐的列表项，供群发对象等使用（含 type、avatarDataUrl 便于群发页筛选与真实头像） */
export type ZeusSignalChatListItem = {
  peerId: string;
  title?: string;
  unreadCount?: number;
  topMessageId?: number;
  type?: 'user' | 'group';
  /** 头像 data URL（前 N 条从本地文件读取） */
  avatarDataUrl?: string;
};

/** 前 N 条会话带真实头像，避免一次读取过多文件阻塞 */
const ZEUS_CHAT_LIST_AVATAR_LIMIT = 150;

/**
 * 从本地绝对路径读取头像文件并转为 data URL；占位路径或不存在则返回 undefined。
 */
function readAvatarAsDataUrl(absolutePath: string | undefined): string | undefined {
  if (!absolutePath || absolutePath === SIGNAL_AVATAR_PATH) return undefined;
  if (!absolutePath.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(absolutePath)) return undefined;
  try {
    if (!existsSync(absolutePath)) return undefined;
    const buf = readFileSync(absolutePath);
    const lower = absolutePath.toLowerCase();
    const mime =
      lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * 推送当前会话列表到主进程（群发页「群发对象」等使用）。
 * 排除本账号会话，仅上报与其它联系人的会话；带 title（昵称/群名）与 type（user/group）便于展示与筛选。
 * 主进程在「当前账号切换」或创建后延迟会下发 zeus-request-chat-list，收到后调用本函数。
 */
export function pushZeusChatList(): void {
  try {
    const controller = window.ConversationController;
    if (!controller?.getAll) return;
    const ourId = controller.getOurConversationId?.() ?? null;
    const all = controller.getAll();
    const items: ZeusSignalChatListItem[] = [];
    let avatarCount = 0;
    for (const convo of all) {
      const id = convo.get?.('id');
      if (id == null || id === ourId) continue;
      const attrs = convo.attributes;
      const title =
        typeof convo.getTitle === 'function'
          ? convo.getTitle()
          : attrs?.name ?? attrs?.profileName ?? attrs?.e164 ?? undefined;
      const unreadCount = convo.get?.('unreadCount');
      const type: 'user' | 'group' | undefined = attrs && isGroup(attrs) ? 'group' : 'user';
      let avatarDataUrl: string | undefined;
      if (avatarCount < ZEUS_CHAT_LIST_AVATAR_LIMIT && attrs) {
        const path = getRawAvatarPath(attrs);
        avatarDataUrl = readAvatarAsDataUrl(path);
        if (avatarDataUrl) avatarCount += 1;
      }
      items.push({
        peerId: String(id),
        title: title != null ? String(title) : undefined,
        type,
        ...(typeof unreadCount === 'number' && unreadCount > 0 ? { unreadCount } : {}),
        ...(avatarDataUrl ? { avatarDataUrl } : {}),
      });
    }
    ipcRenderer.send(ZEUS_CHANNEL_CHAT_LIST, { items });
  } catch (_) {}
}

/**
 * 上报「消息已发送」事件（与 TWeb 共用 zeus-tweb-message-sent，主进程转发给前端）。
 * Signal 在发送成功处（如 handleMessageSend 回调）调用此函数。
 */
export function pushZeusMessageSent(payload: { peerId: string; messageId?: number }): void {
  try {
    ipcRenderer.send(ZEUS_CHANNEL_MESSAGE_SENT, payload);
  } catch (_) {}
}

/**
 * 群发发送：主进程发 zeus-broadcast-send-message 时调用。
 * 若 Signal 已注册 window.__zeusSignalSendMessage(peerId, payload) => Promise<{success, error?}>，则调用并回传 zeus-broadcast-send-message-reply。
 */
function registerZeusBroadcastSendMessage(): void {
  try {
    ipcRenderer.on(
      'zeus-broadcast-send-message',
      async (
        _event: Electron.IpcRendererEvent,
        msg: { peerId: string; payload: Record<string, unknown>; replyId: string }
      ) => {
        const reply = (result: { success: boolean; error?: string }) => {
          try {
            ipcRenderer.send('zeus-broadcast-send-message-reply', {
              replyId: msg.replyId,
              success: result.success,
              error: result.error,
            });
          } catch (_) {}
        };
        const send = (window as unknown as { __zeusSignalSendMessage?: (peerId: string, payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }> }).__zeusSignalSendMessage;
        if (typeof send !== 'function') {
          reply({
            success: false,
            error: 'Signal 未注册群发发送接口。请设置 window.__zeusSignalSendMessage(peerId, payload)。',
          });
          return;
        }
        try {
          const raw = await Promise.resolve(send(msg.peerId, msg.payload ?? {}));
          reply(
            raw != null && typeof raw === 'object' && 'success' in raw
              ? raw
              : { success: false, error: '发送返回格式无效' }
          );
        } catch (e) {
          reply({
            success: false,
            error: e instanceof Error ? e.message : '发送失败',
          });
        }
      }
    );
  } catch (_) {}
}

/**
 * 主进程请求打开会话时（群发页「在应用内打开」等）调用 reduxActions.conversations.showConversation。
 */
function registerZeusOpenChat(): void {
  try {
    ipcRenderer.on('zeus-open-chat', (_event: Electron.IpcRendererEvent, conversationId: string) => {
      const id = typeof conversationId === 'string' ? conversationId.trim() : '';
      if (!id) return;
      const actions = (window as unknown as { reduxActions?: { conversations?: { showConversation: (p: { conversationId: string }) => void } } }).reduxActions;
      actions?.conversations?.showConversation?.({ conversationId: id });
    });
  } catch (_) {}
}

/**
 * 注册主进程「请求会话列表」监听，便于群发页等获取到数据。
 * 在平台 isReady（ConversationController 存在且已登录）后再注册，避免未就绪时访问导致报错。
 */
function registerZeusRequestChatList(): void {
  try {
    ipcRenderer.on('zeus-request-chat-list', () => {
      pushZeusChatList();
    });
  } catch (_) {}
}

/** Signal 平台 isReady：ConversationController 存在且已登录（getOurConversationId 有值） */
function waitUntilReady(): Promise<void> {
  const POLL_MS = 200;
  const READY_TIMEOUT_MS = 90_000;
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      const controller = window.ConversationController;
      const ourId = controller?.getOurConversationId?.() ?? null;
      if (controller && ourId != null && ourId !== '') {
        try {
          ipcRenderer.send(ZEUS_CHANNEL_SESSION_STATUS, { status: 'ready' });
        } catch (_) {}
        console.log('[Signal zeusEmbed] isReady：已登录，注册 zeus-request-chat-list');
        resolve();
        return;
      }
      if (Date.now() - start >= READY_TIMEOUT_MS) {
        try {
          ipcRenderer.send(ZEUS_CHANNEL_SESSION_STATUS, { status: 'need_login' });
        } catch (_) {}
        console.warn('[Signal zeusEmbed] isReady 超时，仍注册 zeus-request-chat-list');
        resolve();
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

// 与主进程的群发、打开会话、会话列表等 IPC；等 isReady 后再注册 request-chat-list
waitUntilReady().then(() => {
  registerZeusRequestChatList();
  registerZeusBroadcastSendMessage();
  registerZeusOpenChat();
});
