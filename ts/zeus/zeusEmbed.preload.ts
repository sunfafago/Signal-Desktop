// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zeus 嵌入逻辑：与主进程通信的 IPC 推送（会话列表登录信息、头像、未读数、发送结果等）。
 * 单独定义便于后期优化与扩展，不散落在 background 各处。
 */
import { ipcRenderer } from 'electron';
import { createZeusSignalSendMessage } from './zeusSignalBroadcastBridge.preload.js';
import type { ConversationAttributesType } from '../model-types.d.ts';
import { getRawAvatarPath, getLocalAvatarUrl } from '../util/avatarUtils.preload.js';
import { SIGNAL_AVATAR_PATH } from '../types/SignalConversation.std.js';
import type { AvatarColorType } from '../types/Colors.std.js';
import { AvatarColorMap, AvatarColors } from '../types/Colors.std.js';
import { migrateColor } from '../util/migrateColor.node.js';
import { getInitials } from '../util/getInitials.std.js';
import { getIdentifierHash } from '../Crypto.node.js';
import { isAciString } from '../util/isAciString.std.js';
import { isGroup, isMe } from '../util/whatTypeOfConversation.dom.js';

// ---------------------------------------------------------------------------
// window 扩展：Zeus preload 与 Signal 页面 bundle 协作挂载的字段（避免散落 as unknown as）
// ---------------------------------------------------------------------------

/** 群发桥接：页面侧实现实际发送 */
export type ZeusSignalSendMessageFn = (
  peerId: string,
  payload: Record<string, unknown>
) => Promise<{ success: boolean; error?: string }>;

type ZeusReduxStoreForEmbed = {
  subscribe: (cb: () => void) => () => void;
  /** 当前会话 peer：registerZeusCurrentChatPeer 必需；指纹监听仅用到 subscribe */
  getState?: () => {
    conversations?: {
      selectedConversationId?: string | undefined;
      /** 与 xsdc ChatList 一致：占位色优先取 Redux 已计算好的 color */
      conversationLookup?: Record<string, { color?: string }>;
    };
  };
};

/** 与 Signal 自带 Window.reduxActions 等分开收窄，避免与全局 Window 声明冲突 */
type ZeusSignalEmbedGlobals = {
  __zeusSignalSendMessage?: ZeusSignalSendMessageFn;
  reduxStore?: ZeusReduxStoreForEmbed;
  reduxActions?: {
    conversations?: { showConversation: (p: { conversationId: string }) => void };
  };
};

function zeusSignalEmbedGlobals(): ZeusSignalEmbedGlobals {
  return window as unknown as ZeusSignalEmbedGlobals;
}

/** 当前登录用户信息推送载荷 */
export type ZeusSignalUserChangedPayload = {
  e164?: string;
  title?: string;
  /** 当前账号 conversation id，供主进程过滤会话列表中的自身 */
  userId?: string;
  /** 用户头像本地绝对路径，主进程据此提供 zeus-avatar://appId 供前端展示 */
  avatarPath?: string;
  /** 无头像时按 Signal 规则生成的占位图（纯色 bg + fg 首字母，与 BetterAvatarBubble 一致）data URL，主进程写入临时文件后按 appId 提供 zeus-avatar */
  avatarDataUrl?: string;
};

const ZEUS_CHANNEL_USER_CHANGED = 'zeus-session-user-changed';
/** 与 zeus-app-unread 统一通道；主进程兼容保留 zeus-signal-unread 监听作为降级保障 */
const ZEUS_CHANNEL_UNREAD = 'zeus-app-unread';
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
/** getTitle 在无 profileName/e164 时返回 i18n 的「未知」，避免用该占位符；优先 profileName + e164 */
function getDisplayTitle(
  ourConversation: { getTitleNoDefault?: (opts?: { isShort?: boolean }) => string | undefined; attributes?: { profileName?: string; profileFamilyName?: string; e164?: string } } | undefined,
  e164: string | undefined
): string {
  if (!ourConversation?.attributes) return e164 ?? '';
  const attrs = ourConversation.attributes;
  const noDefault = ourConversation.getTitleNoDefault?.();
  if (noDefault && noDefault.trim()) return noDefault.trim();
  const profileName = [attrs.profileName, attrs.profileFamilyName].filter(Boolean).join(' ').trim();
  if (profileName) return profileName;
  return e164 ?? '';
}

export function pushZeusUserInfo(storage: ZeusUserStorage): void {
  try {
    const e164 = storage.user.getNumber() ?? undefined;
    const ourConversation =
      window.ConversationController?.getOurConversation?.();
    const title = getDisplayTitle(ourConversation, e164);
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
      const ourId = ourConversation?.get?.('id');
      ipcRenderer.send(ZEUS_CHANNEL_USER_CHANGED, {
        e164,
        title: title || undefined,
        userId: typeof ourId === 'string' ? ourId : undefined,
        avatarPath,
        avatarDataUrl,
      } as ZeusSignalUserChangedPayload);
      // 确保主进程标记为 ready，便于群发页拉取会话列表（requestChatListForAppId）
      ipcRenderer.send(ZEUS_CHANNEL_SESSION_STATUS, { status: 'ready' });
    }
  } catch (_) {}
}

/** 上次上报的未读数，-1 表示尚未初始化，避免首次上报误触发「新消息」通知 */
let _lastSignalUnreadCount = -1;

/**
 * 推送当前未读消息数到主进程（会话列表左上角展示）。
 * 在 ConversationController.updateUnreadCount() 内调用。
 * 未读数增加时额外发送 zeus-app-new-message，供主进程推送桌面通知。
 */
export function pushZeusUnreadCount(unreadCount: number): void {
  try {
    const wasIncrease = _lastSignalUnreadCount >= 0 && unreadCount > _lastSignalUnreadCount;
    _lastSignalUnreadCount = unreadCount;
    ipcRenderer.send(ZEUS_CHANNEL_UNREAD, { unreadCount, rendererChannel: 'signal-unread' });
    if (wasIncrease) {
      ipcRenderer.send('zeus-app-new-message', {});
    }
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
  /** Signal AvatarColorMap 色键，如 "A150"；前端查表（SIGNAL_AVATAR_COLOR_MAP）得 bg/fg，不在此传 hex */
  signalColorKey?: string;
  /** 与桌面 getInitials(title) 一致（含大小写） */
  signalInitials?: string;
};

/** 前 N 条会话带真实头像 */
const ZEUS_CHAT_LIST_AVATAR_LIMIT = 150;
/** 并发加载头像数量，避免同时请求过多 */
const ZEUS_AVATAR_FETCH_CONCURRENCY = 6;
/** 与主进程 zeus-signal-chat-list 分块合并一致 */
const ZEUS_SIGNAL_CHAT_LIST_CHUNK = 400;

function sendSignalChatListPayload(items: ZeusSignalChatListItem[]): void {
  const n = items.length;
  if (n <= ZEUS_SIGNAL_CHAT_LIST_CHUNK) {
    ipcRenderer.send(ZEUS_CHANNEL_CHAT_LIST, { items });
    return;
  }
  const listSyncId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const chunkTotal = Math.ceil(n / ZEUS_SIGNAL_CHAT_LIST_CHUNK);
  for (let i = 0; i < chunkTotal; i++) {
    const slice = items.slice(i * ZEUS_SIGNAL_CHAT_LIST_CHUNK, (i + 1) * ZEUS_SIGNAL_CHAT_LIST_CHUNK);
    ipcRenderer.send(ZEUS_CHANNEL_CHAT_LIST, {
      items: slice,
      listSyncId,
      chunkIndex: i,
      chunkTotal,
    });
  }
}

/**
 * 与 Signal 列表一致的可 fetch 头像地址：本地 attachment://、打包内相对路径、或仅有 remote 时的 HTTPS。
 * getLocalAvatarUrl 对「Signal 官方号」等会返回无协议的 path，需相对 window.location 解析。
 */
function resolveZeusAvatarFetchUrl(attrs: ConversationAttributesType): string | undefined {
  const local = getLocalAvatarUrl(attrs);
  if (local) {
    if (
      local.startsWith('attachment://') ||
      local.startsWith('http://') ||
      local.startsWith('https://') ||
      local.startsWith('file://')
    ) {
      return local;
    }
    if (!local.includes('://')) {
      try {
        return new URL(local, window.location.origin).href;
      } catch {
        return undefined;
      }
    }
    return local;
  }
  const remote = attrs.remoteAvatarUrl;
  if (typeof remote === 'string') {
    const t = remote.trim();
    if (/^https?:\/\//i.test(t)) return t;
  }
  return undefined;
}

/**
 * 与 xsdc ChatList 取色顺序一致：Redux conversationLookup[id].color → attrs.color → migrateColor（含哈希回退）。
 * 最后用 migrateColor 统一校验/迁移旧色名。
 */
function resolveZeusSignalListAvatarColorKey(
  conversationId: string,
  attrs: ConversationAttributesType | undefined,
  isSigGroup: boolean
): AvatarColorType {
  let chosen: string | undefined;
  try {
    const store = zeusSignalEmbedGlobals().reduxStore;
    if (store?.getState) {
      const data =
        store.getState()?.conversations?.conversationLookup?.[String(conversationId)];
      if (data?.color != null && String(data.color).trim()) {
        chosen = String(data.color);
      }
    }
  } catch {
    // Redux 可能尚未就绪
  }
  if (!chosen && attrs?.color != null && String(attrs.color).trim()) {
    chosen = String(attrs.color);
  }
  const groupId =
    isSigGroup && attrs ? (attrs.groupId || String(conversationId)) : undefined;
  return migrateColor(chosen as AvatarColorType | undefined, {
    aci: attrs?.serviceId != null && isAciString(attrs.serviceId) ? attrs.serviceId : undefined,
    e164: attrs?.e164,
    pni: attrs?.pni,
    groupId,
  });
}

/** 限制长边像素，缩小 IPC 体积、降低主进程写盘失败概率 */
const ZEUS_LIST_AVATAR_MAX_EDGE_PX = 160;

async function downscaleDataUrlForIpc(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        const maxEdge = Math.max(w, h);
        if (maxEdge <= ZEUS_LIST_AVATAR_MAX_EDGE_PX) {
          resolve(dataUrl);
          return;
        }
        const scale = ZEUS_LIST_AVATAR_MAX_EDGE_PX / maxEdge;
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * fetch 头像字节并转为 data URL。attachment:// 经协议解密后 Blob.type 常为 octet-stream 或空，不能仅用 MIME 判断。
 * 大图会缩放到最长边 ZEUS_LIST_AVATAR_MAX_EDGE_PX，减轻 IPC/落盘压力。
 */
async function fetchAvatarAsDataUrl(avatarUrl: string | undefined): Promise<string | undefined> {
  if (!avatarUrl?.trim()) return undefined;
  try {
    const res = await fetch(avatarUrl);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size === 0) return undefined;
    const mime = blob.type || '';
    if (mime.startsWith('text/')) return undefined;
    const raw = await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
    if (!raw) return undefined;
    return downscaleDataUrlForIpc(raw);
  } catch {
    return undefined;
  }
}

/** 限制并发执行 Promise */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * 推送当前会话列表到主进程（群发页「群发对象」等使用）。
 * 排除本账号会话，带 title、type；头像 URL 解析规则与 getConversation.avatarUrl（getLocalAvatarUrl）一致，并回退 remoteAvatarUrl。
 * 主进程在「当前账号切换」或创建后延迟会下发 zeus-request-chat-list，收到后调用本函数。
 */
export function pushZeusChatList(): void {
  void (async () => {
    try {
      const controller = window.ConversationController;
      if (!controller?.getAll) return;
      const ourId = controller.getOurConversationId?.() ?? null;

      const items: ZeusSignalChatListItem[] = [];
      const avatarUrls: (string | undefined)[] = [];

      for (const convo of controller.getAll()) {
        const id = convo.get?.('id');
        if (id == null || id === ourId) continue;
        const attrs = convo.attributes;
        // 排除「给自己发消息」会话：ourId 可能因格式或时序不一致，用 isMe(e164/serviceId) 双重保障
        if (attrs && isMe(attrs)) continue;

        const isSigGroupEarly = attrs?.type === 'group' || Boolean(attrs && isGroup(attrs));
        // 排除「此人未使用 Signal」或已注销 Signal 的直聊会话：
        // 1. 无 serviceId → 对方从未注册过 Signal
        // 2. firstUnregisteredAt 有值 → 对方曾注册但已注销（对应 Signal Desktop isConversationUnregisteredAndStale）
        if (!isSigGroupEarly && (!attrs?.serviceId || attrs?.firstUnregisteredAt != null)) continue;
        // 排除 Signal 官方号（固定 ACI，对应 isSignalConversation 逻辑）
        if (attrs?.serviceId === '11111111-1111-4111-8111-111111111111') continue;

        const rawTitle =
          typeof convo.getTitle === 'function'
            ? convo.getTitle()
            : attrs?.name ?? attrs?.profileName ?? attrs?.e164;
        const unreadCount = convo.get?.('unreadCount');
        const isSigGroup = isSigGroupEarly;

        let signalColorKey: string | undefined;
        try {
          signalColorKey = resolveZeusSignalListAvatarColorKey(String(id), attrs, isSigGroup);
        } catch (_) {}

        const sigInitials = rawTitle != null ? getInitials(String(rawTitle)) : undefined;

        items.push({
          peerId: String(id),
          ...(rawTitle != null ? { title: String(rawTitle) } : {}),
          type: isSigGroup ? 'group' : 'user',
          ...(typeof unreadCount === 'number' && unreadCount > 0 ? { unreadCount } : {}),
          ...(signalColorKey ? { signalColorKey } : {}),
          ...(sigInitials ? { signalInitials: sigInitials } : {}),
        });
        avatarUrls.push(
          items.length <= ZEUS_CHAT_LIST_AVATAR_LIMIT && attrs ? resolveZeusAvatarFetchUrl(attrs) : undefined
        );
      }

      sendSignalChatListPayload(items);

      const dataUrls = await mapWithConcurrency(avatarUrls, ZEUS_AVATAR_FETCH_CONCURRENCY, fetchAvatarAsDataUrl);
      dataUrls.forEach((dataUrl, i) => {
        if (dataUrl) items[i].avatarDataUrl = dataUrl;
      });

      sendSignalChatListPayload(items);
    } catch (_) {}
  })();
}

/**
 * 会话 id 集合变化时防抖全量推送（与 registerZeusRequestChatList 不冲突：后者是主进程主动拉取，本函数是本地模型变化时推送）。
 */
let _zeusSignalConversationFingerprint = '';
function registerZeusChatListConversationFingerprint(): void {
  try {
    const store = zeusSignalEmbedGlobals().reduxStore;
    if (!store?.subscribe) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    store.subscribe(() => {
      if (debounceTimer != null) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        try {
          const controller = window.ConversationController;
          if (!controller?.getAll) return;
          const all = controller.getAll();
          const ids = all
            .map((c) => String(c.get?.('id') ?? ''))
            .filter(Boolean)
            .sort()
            .join('\n');
          if (ids === _zeusSignalConversationFingerprint) return;
          _zeusSignalConversationFingerprint = ids;
          pushZeusChatList();
        } catch (_) {}
      }, 800);
    });
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
        const send = zeusSignalEmbedGlobals().__zeusSignalSendMessage;
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
 * 订阅 Redux 当前会话变化，上报 zeus-webview-current-chat-peer 供主进程翻译配置按会话区分。
 */
function registerZeusCurrentChatPeer(): void {
  try {
    const store = zeusSignalEmbedGlobals().reduxStore;
    const getState = store?.getState;
    if (!store?.subscribe || !getState) return;
    let lastId: string | null = null;
    store.subscribe(() => {
      const id = getState()?.conversations?.selectedConversationId ?? null;
      if (id !== lastId) {
        lastId = id;
        ipcRenderer.send('zeus-webview-current-chat-peer', id ?? null);
      }
    });
    // 初始化时发送一次
    lastId = getState()?.conversations?.selectedConversationId ?? null;
    ipcRenderer.send('zeus-webview-current-chat-peer', lastId ?? null);
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
      const actions = zeusSignalEmbedGlobals().reduxActions;
      actions?.conversations?.showConversation?.({ conversationId: id });
    });
  } catch (_) {}
}

/**
 * 主进程下发 zeus-request-chat-list 时立即 pushZeusChatList（主动拉取）。
 * 与 registerZeusChatListConversationFingerprint（会话集合变化时推送）互补，非互斥。
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

function registerZeusEmbedAfterReady(): void {
  zeusSignalEmbedGlobals().__zeusSignalSendMessage = createZeusSignalSendMessage();
  registerZeusRequestChatList();
  registerZeusBroadcastSendMessage();
  registerZeusOpenChat();
  registerZeusCurrentChatPeer();
  registerZeusChatListConversationFingerprint();
}

// 与主进程的群发、打开会话、会话列表等 IPC；等 isReady 后再挂 window 与监听器
waitUntilReady().then(registerZeusEmbedAfterReady);
