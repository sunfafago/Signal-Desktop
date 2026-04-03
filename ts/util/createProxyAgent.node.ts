// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import net, { type TcpSocketConnectOpts } from 'node:net';
import { readFileSync } from 'node:fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { URL } from 'node:url';
import type { LookupOptions, LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';

import { createLogger } from '../logging/log.std.ts';
import { happyEyeballs } from './createHTTPSAgent.node.ts';
import type { ConnectOptionsType } from './createHTTPSAgent.node.ts';
import { explodePromise } from './explodePromise.std.ts';
import { SECOND } from './durations/index.std.ts';
import { drop } from './drop.std.ts';

const log = createLogger('createProxyAgent');

// Warning threshold
const CONNECT_THRESHOLD_MS = SECOND;

const SOCKS_PROTOCOLS = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);

export type ProxyAgent =
  | HttpsProxyAgent<'http:'>
  | HttpsProxyAgent<'https:'>
  | SocksProxyAgent;

/**
 * 通过 IPC 读取 Zeus 主进程的 TLS 设置，与 createHTTPSAgent 保持一致：
 * - rejectUnauthorized：在嵌入场景下主进程固定返回 false，兼容企业 SSL 检查代理
 * - ca：合并了 Node 内置根证 + Windows 企业根证 + Signal 自身 CA 的文件路径
 */
function getZeusTlsOptions(): { rejectUnauthorized: boolean; ca: string | undefined } {
  let rejectUnauthorized = false;
  let ca: string | undefined;
  try {
    const electron = require('electron') as {
      ipcRenderer: { sendSync: (channel: string) => unknown };
    };
    const v = electron.ipcRenderer.sendSync('get-signal-tls-reject-unauthorized');
    rejectUnauthorized = v === true;
    const caPath = electron.ipcRenderer.sendSync('get-signal-ca-path') as string | undefined;
    if (typeof caPath === 'string' && caPath) {
      ca = readFileSync(caPath, 'utf8');
    }
  } catch {
    rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1';
  }
  return { rejectUnauthorized, ca };
}

export async function createProxyAgent(proxyUrl: string): Promise<ProxyAgent> {
  const { port: portStr, hostname: proxyHost, protocol } = new URL(proxyUrl);
  let defaultPort: number | undefined;
  let agentClass: typeof HttpsProxyAgent | typeof SocksProxyAgent;
  if (protocol === 'http:') {
    defaultPort = 80;
    agentClass = HttpsProxyAgent;
  } else if (protocol === 'https:') {
    defaultPort = 443;
    agentClass = HttpsProxyAgent;
  } else if (SOCKS_PROTOCOLS.has(protocol)) {
    defaultPort = 1080;
    agentClass = SocksProxyAgent;
  } else {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
  const port = portStr ? parseInt(portStr, 10) : defaultPort;

  async function happyLookup(host: string): Promise<LookupAddress> {
    const addresses = await lookup(host, { all: true });

    // SOCKS 4/5 resolve target host before sending it to the proxy.
    if (host !== proxyHost) {
      const idx = Math.floor(Math.random() * addresses.length);
      // oxlint-disable-next-line typescript/no-non-null-assertion
      return addresses[idx]!;
    }

    const start = Date.now();

    const { socket, address, v4Attempts, v6Attempts } = await happyEyeballs({
      addresses,
      port,
      connect,
    });

    const duration = Date.now() - start;
    const logLine =
      `createProxyAgent.lookup: connected to ` +
      `IPv${address.family} addr after ${duration}ms ` +
      `(attempts v4=${v4Attempts} v6=${v6Attempts})`;

    if (v4Attempts + v6Attempts > 1 || duration > CONNECT_THRESHOLD_MS) {
      log.warn(logLine);
    } else {
      log.info(logLine);
    }

    // Sadly we can't return socket to proxy-agent
    socket.destroy();

    return address;
  }

  type CoercedCallbackType = (
    err: NodeJS.ErrnoException | null,
    address: string | Array<LookupAddress>,
    family?: number
  ) => void;

  async function happyLookupWithCallback(
    host: string,
    opts: LookupOptions,
    callback: CoercedCallbackType
  ): Promise<void> {
    try {
      const addr = await happyLookup(host);
      if (opts.all) {
        callback(null, [addr]);
      } else {
        const { address, family } = addr;
        callback(null, address, family);
      }
    } catch (error) {
      callback(error, '', -1);
    }
  }

  const { rejectUnauthorized, ca } = getZeusTlsOptions();

  return new agentClass(proxyUrl, {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
    lookup:
      port !== undefined
        ? (host, opts, callback) =>
            drop(
              happyLookupWithCallback(
                host,
                opts,
                callback as CoercedCallbackType
              )
            )
        : undefined,
  } satisfies Pick<TcpSocketConnectOpts, 'lookup'> & {
    rejectUnauthorized?: boolean;
    ca?: string;
  });
}

async function connect({
  port,
  address,
  abortSignal,
}: ConnectOptionsType): Promise<net.Socket> {
  const socket = net.connect({
    port,
    host: address,
    signal: abortSignal,
  });

  const { promise: onConnect, resolve, reject } = explodePromise<void>();

  socket.once('connect', resolve);
  socket.once('error', reject);

  try {
    await onConnect;
  } finally {
    socket.removeListener('connect', resolve);
    socket.removeListener('error', reject);
  }

  return socket;
}
