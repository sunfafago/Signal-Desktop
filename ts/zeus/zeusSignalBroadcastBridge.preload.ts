// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zeus 群发桥接：实现 window.__zeusSignalSendMessage(peerId, payload)。
 * 与 telegramk broadcast-bridge 对齐，支持 type: 'text' | 'image' | 'imageText' | 'file'。
 * peerId 即 conversationId；payload 含 type、text、imageDataUrl、caption 等。
 */
import { isSignalConversation } from '../util/isSignalConversation.dom.js';
import { processAttachment } from '../util/processAttachment.preload.js';

function safeTrim(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

/**
 * data URL 转 File（供 processAttachment 使用）
 */
async function dataUrlToFile(dataUrl: string, defaultName: string, defaultType: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const ext = defaultType.startsWith('image/')
    ? (defaultType === 'image/png' ? 'png' : defaultType === 'image/jpeg' ? 'jpg' : 'png')
    : 'bin';
  return new File([blob], defaultName.endsWith(`.${ext}`) ? defaultName : `${defaultName}.${ext}`, {
    type: blob.type || defaultType,
  });
}

/**
 * 创建 Zeus 群发发送实现：使用 ConversationController + enqueueMessageForSend。
 * 在 waitUntilReady 后调用并赋给 window.__zeusSignalSendMessage。
 */
export function createZeusSignalSendMessage(): (
  peerId: string,
  payload: Record<string, unknown>
) => Promise<{ success: boolean; error?: string }> {
  return async (
    peerId: string,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (payload == null || typeof payload !== 'object') {
        return { success: false, error: 'payload 无效' };
      }
      const peerIdTrim = typeof peerId === 'string' ? peerId.trim() : '';
      if (!peerIdTrim) {
        return { success: false, error: 'peerId 为空，请选择群发对象' };
      }

      const controller = window.ConversationController;
      if (!controller?.get) {
        return { success: false, error: 'ConversationController 未就绪' };
      }
      const conversation = controller.get(peerIdTrim);
      if (!conversation) {
        return { success: false, error: `会话不存在: ${peerIdTrim}` };
      }
      if (isSignalConversation(conversation.attributes)) {
        return { success: false, error: '不支持向 Signal 系统会话发送' };
      }

      const type = payload.type as string | undefined;
      if (type == null || typeof type !== 'string') {
        return { success: false, error: '缺少 type 或 type 非字符串' };
      }

      if (type === 'text') {
        const text = safeTrim(payload?.text ?? payload?.message);
        if (!text) return { success: false, error: '文本为空' };
        await conversation.enqueueMessageForSend({ body: text, attachments: [] });
        return { success: true };
      }

      const processDataUrl = async (
        dataUrl: string,
        defaultName: string,
        defaultType: string
      ) => {
        const file = await dataUrlToFile(dataUrl, defaultName, defaultType);
        const attachment = await processAttachment(file, {
          generateScreenshot: true,
          flags: null,
        });
        return attachment;
      };

      if (type === 'image') {
        const imageDataUrl = (payload?.imageDataUrl ?? payload?.image) as string | undefined;
        if (!imageDataUrl || typeof imageDataUrl !== 'string') {
          return { success: false, error: '缺少图片数据' };
        }
        const attachment = await processDataUrl(imageDataUrl, 'image', 'image/png');
        if (!attachment) return { success: false, error: '图片处理失败' };
        await conversation.enqueueMessageForSend({
          body: undefined,
          attachments: [attachment],
        });
        return { success: true };
      }

      if (type === 'imageText') {
        const imageDataUrl = (payload?.imageDataUrl ?? payload?.image) as string | undefined;
        const text = safeTrim(payload?.text ?? payload?.message);
        if (!imageDataUrl || typeof imageDataUrl !== 'string') {
          return { success: false, error: '缺少图片数据' };
        }
        const attachment = await processDataUrl(imageDataUrl, 'image', 'image/png');
        if (!attachment) return { success: false, error: '图片处理失败' };
        await conversation.enqueueMessageForSend({
          body: text || undefined,
          attachments: [attachment],
        });
        return { success: true };
      }

      if (type === 'file') {
        const fileDataUrl = (payload?.fileDataUrl ?? payload?.file) as string | undefined;
        const fileName = (payload?.fileName ?? payload?.name ?? 'file') as string;
        if (!fileDataUrl || typeof fileDataUrl !== 'string') {
          return { success: false, error: '缺少文件数据' };
        }
        const attachment = await processDataUrl(
          fileDataUrl,
          fileName,
          'application/octet-stream'
        );
        if (!attachment) return { success: false, error: '文件处理失败' };
        const caption = safeTrim(payload?.text ?? payload?.caption);
        await conversation.enqueueMessageForSend({
          body: caption || undefined,
          attachments: [attachment],
        });
        return { success: true };
      }

      return { success: false, error: `不支持的 type: ${type}` };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : '发送失败',
      };
    }
  };
}
