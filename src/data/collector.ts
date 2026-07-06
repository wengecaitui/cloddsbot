// src/data/collector.ts
// Phase 5: Bitget WebSocket 采集器 — 断线重连 / 多频道 / 环形缓冲

import { RingBuffer } from "./types";
import type { WsChannel, WsTrade, WsKline, WsDepth, WsTicker, RawTick } from "./types";

const BITGET_WS_PUBLIC = "wss://ws.bitget.com/mix/v1/stream";

export interface CollectorConfig {
  instIds: string[];
  channels?: WsChannel[];
  reconnectDelayMs?: number;
  maxBufferSize?: number;
}

export class BitgetCollector {
  private ws: WebSocket | null = null;
  private config: Required<Omit<CollectorConfig, "private">>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isManualClose = false;
  private _msgBuffer: RingBuffer<RawTick>;

  private _onTrade?: (t: WsTrade) => void;
  private _onKline?: (k: WsKline) => void;
  private _onDepth?: (d: WsDepth) => void;
  private _onTicker?: (t: WsTicker) => void;
  private _onRaw?: (t: RawTick) => void;

  constructor(cfg: CollectorConfig) {
    this.config = {
      instIds: cfg.instIds,
      channels: cfg.channels ?? ["trade", "kline", "depth"],
      reconnectDelayMs: cfg.reconnectDelayMs ?? 3000,
      maxBufferSize: cfg.maxBufferSize ?? 20000,
    };
    this._msgBuffer = new RingBuffer(this.config.maxBufferSize);
  }

  async start(): Promise<void> {
    return new Promise(resolve => this.connect(resolve));
  }

  stop(): void {
    this.isManualClose = true;
    this.ws?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log("[Collector] stopped");
  }

  get buffer(): RingBuffer<RawTick> { return this._msgBuffer; }

  onTrade(cb: (t: WsTrade) => void): void { this._onTrade = cb; }
  onKline(cb: (k: WsKline) => void): void { this._onKline = cb; }
  onDepth(cb: (d: WsDepth) => void): void { this._onDepth = cb; }
  onTicker(cb: (t: WsTicker) => void): void { this._onTicker = cb; }
  onAny(cb: (t: RawTick) => void): void { this._onRaw = cb; }

  private connect(onOpen?: () => void): void {
    console.log(`[Collector] connect -> ${BITGET_WS_PUBLIC}`);
    try {
      this.ws = new WebSocket(BITGET_WS_PUBLIC);
    } catch (e) {
      console.error("[Collector] WS create error:", e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[Collector] connected");
      this.subscribe();
      onOpen?.();
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg: RawTick = JSON.parse(ev.data);
        this._msgBuffer.push(msg);
        this._onRaw?.(msg);
        this.dispatch(msg);
      } catch { /* skip */ }
    };

    this.ws.onclose = () => {
      if (!this.isManualClose) this.scheduleReconnect();
    };
    this.ws.onerror = (err) => console.error("[Collector] error:", err);
  }

  private scheduleReconnect(): void {
    if (this.isManualClose) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[Collector] reconnect in ${this.config.reconnectDelayMs}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectDelayMs);
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const args = this.config.instIds.flatMap(id =>
      this.config.channels.map(ch => ({
        instType: "sp",
        channel: ch === "kline" ? "kline1m" : ch === "depth" ? "books1" : ch,
        instIds: [id],
      }))
    );
    this.ws.send(JSON.stringify({ op: "subscribe", args }));
    console.log(`[Collector] subscribed ${args.length} channels`);
  }

  private dispatch(msg: RawTick): void {
    switch (msg.channel) {
      case "trade":   this._onTrade?.(msg as WsTrade); break;
      case "kline":   this._onKline?.(msg as WsKline); break;
      case "depth":   this._onDepth?.(msg as WsDepth); break;
      case "ticker":  this._onTicker?.(msg as WsTicker); break;
    }
  }
}

export function createCollector(instIds?: string[]): BitgetCollector {
  return new BitgetCollector({ instIds: instIds ?? ["BTCUSDT", "ETHUSDT"] });
}

let _global: BitgetCollector | null = null;
export function getCollector(): BitgetCollector {
  if (!_global) _global = createCollector();
  return _global;
}
export function shutdownCollector(): void { _global?.stop(); _global = null; }
