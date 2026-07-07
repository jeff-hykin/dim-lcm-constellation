// LCM Main Class - Pure TypeScript Implementation

import type {
  LCMOptions,
  LCMMessage,
  MessageClass,
  ParsedUrl,
  Subscription,
  SubscriptionHandler,
  PacketHandler,
  PacketSubscription,
} from "./types.ts";
import { MAX_SMALL_MESSAGE, SHORT_HEADER_SIZE } from "./types.ts";
import { parseUrl } from "./url.ts";
import {
  UdpMulticastSocket,
  FragmentReassembler,
  encodeSmallMessage,
  encodeFragmentedMessage,
  decodePacket,
} from "./transport.ts";

const textEncoder = new TextEncoder();

/**
 * LCM - Lightweight Communications and Marshalling
 *
 * A pure TypeScript implementation of the LCM protocol for Deno.
 *
 * @example
 * ```ts
 * const lcm = new LCM();
 * await lcm.start();
 *
 * // Subscribe with typed messages (type suffix added automatically)
 * lcm.subscribe("/pose", Pose, (msg) => {
 *   console.log("Pose:", msg.data.x, msg.data.y);
 * });
 *
 * // Subscribe to raw messages
 * lcm.subscribeRaw("EXAMPLE", (msg) => {
 *   console.log("Received:", msg.channel, msg.data);
 * });
 *
 * // Publish a message (type suffix added automatically)
 * const pose = new Pose({ x: 1.0, y: 2.0, z: 3.0 });
 * await lcm.publish("/pose", pose);
 *
 * // Handle messages
 * await lcm.handleAsync();
 * ```
 */
export class LCM {
  private readonly config: ParsedUrl;
  private socket: UdpMulticastSocket | null = null;
  private reassembler = new FragmentReassembler();
  private subscriptions: Subscription[] = [];
  private packetSubscriptions: PacketSubscription[] = [];
  private sequenceNumber = 0;
  private running = false;
  private messageQueue: LCMMessage<Uint8Array>[] = [];

  constructor(url?: string);
  constructor(options?: LCMOptions);
  constructor(urlOrOptions?: string | LCMOptions) {
    if (typeof urlOrOptions === "string") {
      this.config = parseUrl(urlOrOptions);
    } else {
      this.config = parseUrl(urlOrOptions?.url);
      if (urlOrOptions?.ttl !== undefined) {
        this.config.ttl = urlOrOptions.ttl;
      }
      if (urlOrOptions?.iface !== undefined) {
        this.config.iface = urlOrOptions.iface;
      }
    }
  }

  /** Start the LCM instance (begin listening for messages) */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.socket = new UdpMulticastSocket(this.config);
    this.running = true;

    await this.socket.listen((data, _addr) => {
      this.handlePacket(data);
    });
  }

  /** Stop the LCM instance */
  stop(): void {
    this.running = false;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Subscribe to a channel with raw data.
   *
   * @param channelPattern - Channel name or regex pattern (use .* for wildcards)
   * @param handler - Callback function for received messages
   * @returns Unsubscribe function
   */
  subscribeRaw(
    channelPattern: string,
    handler: SubscriptionHandler<Uint8Array>
  ): () => void {
    const pattern = this.channelToRegex(channelPattern);
    const subscription: Subscription = {
      channel: channelPattern,
      pattern,
      handler: handler as SubscriptionHandler<unknown>,
    };

    this.subscriptions.push(subscription);

    return () => {
      const idx = this.subscriptions.indexOf(subscription);
      if (idx !== -1) {
        this.subscriptions.splice(idx, 1);
      }
    };
  }

  /**
   * Subscribe to raw UDP packets.
   * Useful for forwarding packets to WebSocket clients without parsing.
   *
   * @param handler - Callback function for received packets (no pattern = all packets)
   * @returns Unsubscribe function
   *
   * @example
   * // Forward all packets
   * lcm.subscribePacket((packet) => ws.send(packet));
   */
  subscribePacket(handler: PacketHandler): () => void;
  /**
   * Subscribe to raw UDP packets with channel pattern filtering.
   *
   * @param channelPattern - Channel pattern to match (e.g., "/vector#*")
   * @param handler - Callback function for received packets
   * @returns Unsubscribe function
   *
   * @example
   * // Forward only matching packets
   * lcm.subscribePacket("/vector#*", (packet) => ws.send(packet));
   */
  subscribePacket(channelPattern: string, handler: PacketHandler): () => void;
  subscribePacket(
    patternOrHandler: string | PacketHandler,
    maybeHandler?: PacketHandler
  ): () => void {
    const pattern = typeof patternOrHandler === "string"
      ? this.channelToRegex(patternOrHandler)
      : null;
    const handler = typeof patternOrHandler === "function"
      ? patternOrHandler
      : maybeHandler!;

    const subscription: PacketSubscription = { pattern, handler };
    this.packetSubscriptions.push(subscription);

    return () => {
      const idx = this.packetSubscriptions.indexOf(subscription);
      if (idx !== -1) {
        this.packetSubscriptions.splice(idx, 1);
      }
    };
  }

  /**
   * Subscribe to a channel with typed message decoding.
   * The type name is automatically appended from msgClass._NAME.
   *
   * @param channel - Channel name (type suffix added automatically)
   * @param msgClass - Message class with decode method (generated LCM type)
   * @param handler - Callback function for received messages
   * @returns Unsubscribe function
   *
   * @example
   * // Subscribes to "/vector#geometry_msgs.Vector3"
   * lcm.subscribe("/vector", Vector3, (msg) => { ... });
   */
  subscribe<T>(
    channel: string,
    msgClass: MessageClass<T>,
    handler: SubscriptionHandler<T>
  ): () => void {
    // Build full channel with type suffix: "channel#typename"
    const typeName = (msgClass as unknown as { _NAME: string })._NAME;
    const fullChannel = channel.includes("#") ? channel : `${channel}#${typeName}`;
    const pattern = this.channelToRegex(fullChannel);

    const subscription: Subscription = {
      channel: fullChannel,
      pattern,
      handler: handler as SubscriptionHandler<unknown>,
      msgClass: msgClass as MessageClass<unknown>,
    };

    this.subscriptions.push(subscription);

    return () => {
      const idx = this.subscriptions.indexOf(subscription);
      if (idx !== -1) {
        this.subscriptions.splice(idx, 1);
      }
    };
  }

  /**
   * Publish a raw message.
   *
   * @param channel - Channel name to publish on
   * @param data - Raw message data
   */
  async publishRaw(channel: string, data: Uint8Array): Promise<void> {
    if (!this.socket) {
      throw new Error("LCM not started. Call start() first.");
    }

    const channelBytes = textEncoder.encode(channel);
    const totalSize = SHORT_HEADER_SIZE + channelBytes.length + 1 + data.length;

    const seq = this.sequenceNumber++;

    if (totalSize <= MAX_SMALL_MESSAGE) {
      // Small message - single packet
      const packet = encodeSmallMessage(channel, data, seq);
      await this.socket.send(packet);
    } else {
      // Large message - fragmented
      const fragments = encodeFragmentedMessage(channel, data, seq);
      for (const fragment of fragments) {
        await this.socket.send(fragment);
      }
    }
  }

  /**
   * Publish a typed message.
   * The type name is automatically appended from the message's constructor._NAME.
   *
   * @param channel - Channel name to publish on (type suffix added automatically)
   * @param msg - Message instance with encode() method
   *
   * @example
   * // Publishes to "/vector#geometry_msgs.Vector3"
   * lcm.publish("/vector", new Vector3({ x: 1, y: 2, z: 3 }));
   */
  async publish<T extends { encode(): Uint8Array }>(
    channel: string,
    msg: T
  ): Promise<void> {
    const data = msg.encode();
    // Get type name from constructor's _NAME static property
    const typeName = (msg.constructor as unknown as { _NAME?: string })._NAME;
    const fullChannel = typeName && !channel.includes("#")
      ? `${channel}#${typeName}`
      : channel;
    await this.publishRaw(fullChannel, data);
  }

  /**
   * Publish a pre-encoded LCM packet.
   * Useful for forwarding packets received from WebSocket clients.
   *
   * @param packet - Raw LCM packet (with header, channel, and payload)
   *
   * @example
   * // Forward packet from WebSocket to LCM network
   * ws.onmessage = (event) => {
   *   lcm.publishPacket(new Uint8Array(event.data));
   * };
   */
  async publishPacket(packet: Uint8Array): Promise<void> {
    if (!this.socket) {
      throw new Error("LCM not started. Call start() first.");
    }
    await this.socket.send(packet);
  }

  /**
   * Handle messages synchronously (blocking).
   * Processes any pending messages and waits for new ones.
   *
   * @param timeoutMs - Timeout in milliseconds (0 = no wait, -1 = wait forever)
   * @returns Number of messages handled
   */
  handle(timeoutMs: number = 0): number {
    const messages = this.messageQueue.splice(0);
    for (const msg of messages) {
      this.dispatchMessage(msg);
    }
    return messages.length;
  }

  /**
   * Handle messages asynchronously.
   * Waits for at least one message or timeout.
   *
   * @param timeoutMs - Timeout in milliseconds (-1 = wait forever)
   * @returns Number of messages handled
   */
  async handleAsync(timeoutMs: number = 100): Promise<number> {
    // Wait for messages or timeout
    const startTime = Date.now();

    while (this.messageQueue.length === 0) {
      if (timeoutMs >= 0 && Date.now() - startTime >= timeoutMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return this.handle();
  }

  /**
   * Run the message loop continuously.
   * This is a convenience method for simple applications.
   *
   * @param callback - Optional callback called after each batch of messages
   */
  async run(callback?: () => void | Promise<void>): Promise<void> {
    while (this.running) {
      await this.handleAsync(100);
      if (callback) {
        await callback();
      }
    }
  }

  /** Convert channel pattern to regex */
  private channelToRegex(pattern: string): RegExp {
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    // Convert * to .* for wildcard matching
    const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
    return new RegExp(regexStr);
  }

  /** Handle an incoming UDP packet */
  private handlePacket(data: Uint8Array): void {
    const decoded = decodePacket(data);
    if (!decoded) {
      return;
    }

    // Dispatch to raw packet handlers first
    const channel = decoded.type === "small"
      ? decoded.channel
      : decoded.channel; // fragments have channel in first fragment

    if (channel) {
      for (const sub of this.packetSubscriptions) {
        if (!sub.pattern || sub.pattern.test(channel)) {
          try {
            sub.handler(data);
          } catch (e) {
            console.error(`Error in raw packet handler:`, e);
          }
        }
      }
    }

    // Continue with normal processing
    if (decoded.type === "small") {
      this.queueMessage(decoded.channel, decoded.data);
    } else {
      // Fragment - try to reassemble
      const complete = this.reassembler.processFragment(decoded);
      if (complete) {
        this.queueMessage(complete.channel, complete.data);
      }
    }
  }

  /** Queue a message for dispatch */
  private queueMessage(channel: string, data: Uint8Array): void {
    const msg: LCMMessage<Uint8Array> = {
      channel,
      data: new Uint8Array(data), // Copy to ensure data isn't reused
      timestamp: Date.now(),
    };
    this.messageQueue.push(msg);
  }

  /** Dispatch a message to matching subscriptions */
  private dispatchMessage(msg: LCMMessage<Uint8Array>): void {
    for (const sub of this.subscriptions) {
      if (sub.pattern.test(msg.channel)) {
        try {
          if (sub.msgClass) {
            // Decode typed message
            const decoded = sub.msgClass.decode(msg.data);
            sub.handler({
              channel: msg.channel,
              data: decoded,
              timestamp: msg.timestamp,
            });
          } else {
            // Raw message
            sub.handler(msg);
          }
        } catch (e) {
          console.error(`Error in subscription handler for ${msg.channel}:`, e);
        }
      }
    }
  }

  /** Get current configuration */
  getConfig(): ParsedUrl {
    return { ...this.config };
  }

  /** Check if LCM is running */
  isRunning(): boolean {
    return this.running;
  }
}
