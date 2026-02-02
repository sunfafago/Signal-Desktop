// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zeus 嵌入逻辑：与主进程通信的 IPC 推送（会话列表登录信息、头像、未读数、发送结果等）。
 * 单独定义便于后期优化与扩展，不散落在 background 各处。
 */
import { ipcRenderer } from 'electron';
import { getRawAvatarPath } from '../util/avatarUtils.preload.js';
import { SIGNAL_AVATAR_PATH } from '../types/SignalConversation.std.js';

/** 当前登录用户信息推送载荷 */
export type ZeusSignalUserChangedPayload = {
  e164?: string;
  title?: string;
  /** 用户头像本地绝对路径，主进程据此提供 zeus-signal-avatar://appId 供前端展示 */
  avatarPath?: string;
};

const ZEUS_CHANNEL_USER_CHANGED = 'zeus-signal-user-changed';
const ZEUS_CHANNEL_UNREAD = 'zeus-signal-unread';

/** 供外部注入的存储接口（仅需 user.getNumber），避免依赖完整 itemStorage 类型 */
export type ZeusUserStorage = {
  user: { getNumber: () => string | undefined };
};

/**
 * 推送当前登录信息到主进程（会话列表用）。
 * 在 userChanged 与「已登录就绪」时各调用一次。
 */
export function pushZeusUserInfo(storage: ZeusUserStorage): void {
  try {
    const e164 = storage.user.getNumber() ?? undefined;
    const ourConversation =
      window.ConversationController?.getOurConversation?.();
    const title = ourConversation?.getTitle?.() ?? '';
    let avatarPath: string | undefined;
    if (ourConversation?.attributes) {
      const avatar = ourConversation.get('profileAvatar') || ourConversation.get('avatar');
      if (avatar?.path && avatar.path !== SIGNAL_AVATAR_PATH) {
        avatarPath = getRawAvatarPath(ourConversation.attributes);
      }
    }
    if (e164 != null || title || avatarPath) {
      ipcRenderer.send(ZEUS_CHANNEL_USER_CHANGED, {
        e164,
        title: title || undefined,
        avatarPath,
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
