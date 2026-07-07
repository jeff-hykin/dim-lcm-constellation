// LCM UDP Multicast Transport

import {
  MAGIC_SHORT,
  MAGIC_LONG,
  MAX_SMALL_MESSAGE,
  SHORT_HEADER_SIZE,
  FRAGMENT_HEADER_SIZE,
} from "./types.ts";
import type { ParsedUrl } from "./types.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a small LCM message (fits in single UDP packet) */
export function encodeSmallMessage(
  channel: string,
  data: Uint8Array,
  sequenceNumber: number
): Uint8Array {
  const channelBytes = textEncoder.encode(channel);
  const totalSize = SHORT_HEADER_SIZE + channelBytes.length + 1 + data.length;

  if (totalSize > MAX_SMALL_MESSAGE) {
    throw new Error(`Message too large for small message format: ${totalSize} > ${MAX_SMALL_MESSAGE}`);
  }

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);

  let offset = 0;

  // Magic number (big-endian)
  view.setUint32(offset, MAGIC_SHORT, false);
  offset += 4;

  // Sequence number (big-endian)
  view.setUint32(offset, sequenceNumber, false);
  offset += 4;

  // Channel name (null-terminated)
  buffer.set(channelBytes, offset);
  offset += channelBytes.length;
  buffer[offset] = 0; // null terminator
  offset += 1;

  // Payload
  buffer.set(data, offset);

  return buffer;
}

/** Encode a fragmented LCM message (requires multiple UDP packets) */
export function encodeFragmentedMessage(
  channel: string,
  data: Uint8Array,
  sequenceNumber: number,
  maxFragmentSize: number = 65000
): Uint8Array[] {
  const channelBytes = textEncoder.encode(channel);
  const payloadSize = data.length;

  // Calculate fragment sizes
  const firstFragmentPayloadSpace = maxFragmentSize - FRAGMENT_HEADER_SIZE - channelBytes.length - 1;
  const subsequentFragmentPayloadSpace = maxFragmentSize - FRAGMENT_HEADER_SIZE;

  // Calculate number of fragments
  let numFragments = 1;
  let remainingBytes = payloadSize - Math.min(payloadSize, firstFragmentPayloadSpace);
  if (remainingBytes > 0) {
    numFragments += Math.ceil(remainingBytes / subsequentFragmentPayloadSpace);
  }

  const fragments: Uint8Array[] = [];
  let payloadOffset = 0;

  for (let fragmentNum = 0; fragmentNum < numFragments; fragmentNum++) {
    const isFirst = fragmentNum === 0;
    const headerSize = FRAGMENT_HEADER_SIZE;
    const channelSize = isFirst ? channelBytes.length + 1 : 0;

    const maxPayloadForThisFragment = isFirst
      ? firstFragmentPayloadSpace
      : subsequentFragmentPayloadSpace;

    const payloadForThisFragment = Math.min(
      maxPayloadForThisFragment,
      payloadSize - payloadOffset
    );

    const fragmentSize = headerSize + channelSize + payloadForThisFragment;
    const fragment = new Uint8Array(fragmentSize);
    const view = new DataView(fragment.buffer);

    let offset = 0;

    // Magic number
    view.setUint32(offset, MAGIC_LONG, false);
    offset += 4;

    // Sequence number
    view.setUint32(offset, sequenceNumber, false);
    offset += 4;

    // Payload size (total, not fragment)
    view.setUint32(offset, payloadSize, false);
    offset += 4;

    // Fragment offset
    view.setUint32(offset, payloadOffset, false);
    offset += 4;

    // Fragment number
    view.setUint16(offset, fragmentNum, false);
    offset += 2;

    // Number of fragments
    view.setUint16(offset, numFragments, false);
    offset += 2;

    // Channel name (first fragment only)
    if (isFirst) {
      fragment.set(channelBytes, offset);
      offset += channelBytes.length;
      fragment[offset] = 0;
      offset += 1;
    }

    // Payload data
    fragment.set(data.subarray(payloadOffset, payloadOffset + payloadForThisFragment), offset);

    payloadOffset += payloadForThisFragment;
    fragments.push(fragment);
  }

  return fragments;
}

/** Decoded small message */
export interface DecodedSmallMessage {
  type: "small";
  channel: string;
  data: Uint8Array;
  sequenceNumber: number;
}

/** Decoded fragment */
export interface DecodedFragment {
  type: "fragment";
  sequenceNumber: number;
  payloadSize: number;
  fragmentOffset: number;
  fragmentNumber: number;
  numFragments: number;
  channel?: string; // Only present in first fragment
  data: Uint8Array;
}

/** Decode a received UDP packet */
export function decodePacket(packet: Uint8Array): DecodedSmallMessage | DecodedFragment | null {
  if (packet.length < SHORT_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const magic = view.getUint32(0, false);

  if (magic === MAGIC_SHORT) {
    return decodeSmallPacket(packet, view);
  } else if (magic === MAGIC_LONG) {
    return decodeFragmentPacket(packet, view);
  }

  return null;
}

function decodeSmallPacket(packet: Uint8Array, view: DataView): DecodedSmallMessage | null {
  const sequenceNumber = view.getUint32(4, false);

  // Find null terminator for channel name
  let channelEnd = SHORT_HEADER_SIZE;
  while (channelEnd < packet.length && packet[channelEnd] !== 0) {
    channelEnd++;
  }

  if (channelEnd >= packet.length) {
    return null; // No null terminator found
  }

  const channel = textDecoder.decode(packet.subarray(SHORT_HEADER_SIZE, channelEnd));
  const data = packet.subarray(channelEnd + 1);

  return {
    type: "small",
    channel,
    data,
    sequenceNumber,
  };
}

function decodeFragmentPacket(packet: Uint8Array, view: DataView): DecodedFragment | null {
  if (packet.length < FRAGMENT_HEADER_SIZE) {
    return null;
  }

  const sequenceNumber = view.getUint32(4, false);
  const payloadSize = view.getUint32(8, false);
  const fragmentOffset = view.getUint32(12, false);
  const fragmentNumber = view.getUint16(16, false);
  const numFragments = view.getUint16(18, false);

  let offset = FRAGMENT_HEADER_SIZE;
  let channel: string | undefined;

  // First fragment contains channel name
  if (fragmentNumber === 0) {
    let channelEnd = offset;
    while (channelEnd < packet.length && packet[channelEnd] !== 0) {
      channelEnd++;
    }
    if (channelEnd >= packet.length) {
      return null;
    }
    channel = textDecoder.decode(packet.subarray(offset, channelEnd));
    offset = channelEnd + 1;
  }

  const data = packet.subarray(offset);

  return {
    type: "fragment",
    sequenceNumber,
    payloadSize,
    fragmentOffset,
    fragmentNumber,
    numFragments,
    channel,
    data,
  };
}

/** Fragment reassembler for handling large messages */
export class FragmentReassembler {
  private pending = new Map<number, {
    channel: string;
    payloadSize: number;
    numFragments: number;
    receivedFragments: Set<number>;
    buffer: Uint8Array;
    lastActivity: number;
  }>();

  private timeoutMs: number;

  constructor(timeoutMs: number = 5000) {
    this.timeoutMs = timeoutMs;
  }

  /** Process a fragment, returns complete message if all fragments received */
  processFragment(fragment: DecodedFragment): { channel: string; data: Uint8Array } | null {
    const now = Date.now();
    this.cleanup(now);

    let entry = this.pending.get(fragment.sequenceNumber);

    if (!entry) {
      if (fragment.fragmentNumber !== 0 || !fragment.channel) {
        // Can't start without first fragment
        return null;
      }

      entry = {
        channel: fragment.channel,
        payloadSize: fragment.payloadSize,
        numFragments: fragment.numFragments,
        receivedFragments: new Set(),
        buffer: new Uint8Array(fragment.payloadSize),
        lastActivity: now,
      };
      this.pending.set(fragment.sequenceNumber, entry);
    }

    // Copy fragment data into buffer
    entry.buffer.set(fragment.data, fragment.fragmentOffset);
    entry.receivedFragments.add(fragment.fragmentNumber);
    entry.lastActivity = now;

    // Check if complete
    if (entry.receivedFragments.size === entry.numFragments) {
      this.pending.delete(fragment.sequenceNumber);
      return {
        channel: entry.channel,
        data: entry.buffer,
      };
    }

    return null;
  }

  /** Clean up old incomplete messages */
  private cleanup(now: number): void {
    for (const [seq, entry] of this.pending) {
      if (now - entry.lastActivity > this.timeoutMs) {
        this.pending.delete(seq);
      }
    }
  }
}

/** UDP Multicast socket wrapper for Deno */
export class UdpMulticastSocket {
  private socket: Deno.DatagramConn | null = null;
  private readonly config: ParsedUrl;
  private running = false;

  constructor(config: ParsedUrl) {
    this.config = config;
  }

  /** Start listening for multicast messages */
  async listen(onMessage: (data: Uint8Array, addr: Deno.NetAddr) => void): Promise<void> {
    // reuseAddress allows multiple processes to bind to the same multicast port
    this.socket = Deno.listenDatagram({
      port: this.config.port,
      transport: "udp",
      hostname: "0.0.0.0",
      reuseAddress: true,
    });

    // LOCAL PATCH (dimos-helm): the upstream @dimos/lcm@0.2.0 never joins the
    // multicast group, so the socket only ever sees unicast and receives nothing
    // (lcmflow showed "WAITING FOR RUN" with no particles/dtop). A datagram
    // socket must explicitly IGMP-join the group to receive multicast — including
    // ttl=0 loopback traffic from local dimos runs. Join on the requested iface,
    // falling back to the default ("0.0.0.0"); tolerate "already joined".
    const joinIface = this.config.iface ?? "0.0.0.0";
    try {
      // @ts-ignore - joinMulticastV4 is present on Deno.DatagramConn (unstable-net)
      await this.socket.joinMulticastV4(this.config.host, joinIface);
    } catch (err) {
      if (joinIface !== "0.0.0.0") {
        try {
          // @ts-ignore
          await this.socket.joinMulticastV4(this.config.host, "0.0.0.0");
        } catch { /* receive may still work if another binder joined */ }
      } else if (!String((err as Error)?.message).includes("in use")) {
        console.error(`lcm: multicast join failed for ${this.config.host} — ${(err as Error)?.message}`);
      }
    }

    this.running = true;

    // Read loop
    (async () => {
      try {
        while (this.running && this.socket) {
          const [data, addr] = await this.socket.receive();
          if (addr.transport === "udp") {
            onMessage(data, addr);
          }
        }
      } catch (e) {
        if (this.running) {
          console.error("UDP receive error:", e);
        }
      }
    })();
  }

  /** Send a UDP packet to the multicast group */
  async send(data: Uint8Array): Promise<void> {
    if (!this.socket) {
      // Create a socket for sending if we don't have one
      this.socket = Deno.listenDatagram({
        port: 0, // Ephemeral port for sending
        transport: "udp",
        hostname: "0.0.0.0",
      });
    }

    await this.socket.send(data, {
      transport: "udp",
      hostname: this.config.host,
      port: this.config.port,
    });
  }

  /** Close the socket */
  close(): void {
    this.running = false;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close errors
      }
      this.socket = null;
    }
  }
}
