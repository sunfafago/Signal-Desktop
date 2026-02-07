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

/** 与主进程 friend-list:get 对齐的列表项，供群发对象等使用 */
export type ZeusSignalChatListItem = {
  peerId: string;
  title?: string;
  unreadCount?: number;
  topMessageId?: number;
};

/**
 * 推送当前会话列表到主进程（群发页「群发对象」等使用）。
 * 排除本账号会话，仅上报与其它联系人的会话。
 * 主进程在「当前账号切换」或创建后延迟会下发 zeus-request-chat-list，收到后调用本函数。
 */
export function pushZeusChatList(): void {
  try {
    const controller = window.ConversationController;
    if (!controller?.getAll) return;
    const ourId = controller.getOurConversationId?.() ?? null;
    const all = controller.getAll();
    const items: ZeusSignalChatListItem[] = [];
    for (const convo of all) {
      const id = convo.get?.('id');
      if (id == null || id === ourId) continue;
      const title = convo.getTitle?.() ?? undefined;
      const unreadCount = convo.get?.('unreadCount');
      items.push({
        peerId: String(id),
        title: title ?? undefined,
        ...(typeof unreadCount === 'number' && unreadCount > 0 ? { unreadCount } : {}),
      });
    }
    ipcRenderer.send(ZEUS_CHANNEL_CHAT_LIST, { items });
  } catch (_) {}
}

/**
 * 注册主进程「请求会话列表」监听，便于群发页等获取到数据。
 * 在 preload 加载时执行一次即可。
 */
function registerZeusRequestChatList(): void {
  try {
    ipcRenderer.on('zeus-request-chat-list', () => {
      pushZeusChatList();
    });
  } catch (_) {}
}

// preload 加载时注册，主进程在切换账号或创建后延迟会下发 zeus-request-chat-list
registerZeusRequestChatList();
