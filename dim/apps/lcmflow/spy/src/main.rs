// constellation-spy — passive sniffer for the LCM Constellation app.
//
// Watches two transports and reports *metadata only* (channel, count, bytes) as
// newline-delimited JSON on stdout, batched every FLUSH_MS:
//   {"kind":"packets","t":<ms>,"events":[[transport,channel,count,bytes],...]}
// For resource_stats channels it also emits the raw payload (base64) so the JS
// launcher can decode the dtop pickle:
//   {"kind":"raw","transport":...,"channel":...,"b64":...}
//
//   - LCM:   UDP multicast 239.255.76.67:7667 (small + fragmented wire format).
//   - Zenoh: peer-mode session with a `**` subscriber (matches dimos zenoh 1.x,
//            which opens peer sessions with default multicast scouting).
// Payloads are never decoded (except resource_stats) — only byte lengths.

use base64::Engine;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LCM_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 76, 67);
const LCM_PORT: u16 = 7667;
const MAGIC_SHORT: u32 = 0x4c43_3032; // "LC02"
const MAGIC_LONG: u32 = 0x4c43_3033; // "LC03"
const SHORT_HEADER_SIZE: usize = 8;
const FRAGMENT_HEADER_SIZE: usize = 20;
const FLUSH_MS: u64 = 50;

// (transport, channel) -> (count, bytes)
type Agg = Arc<Mutex<HashMap<(String, String), (u64, u64)>>>;

fn be_u32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn be_u16(b: &[u8], o: usize) -> u16 {
    u16::from_be_bytes([b[o], b[o + 1]])
}

fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn emit_raw(transport: &str, channel: &str, bytes: &[u8]) {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let value = serde_json::json!({"kind":"raw","transport":transport,"channel":channel,"b64":b64});
    emit(&value.to_string());
}

fn record(agg: &Agg, transport: &str, channel: &str, bytes: u64) {
    let mut map = agg.lock().unwrap();
    let entry = map
        .entry((transport.to_string(), channel.to_string()))
        .or_insert((0, 0));
    entry.0 += 1;
    entry.1 += bytes;
}

fn flush_loop(agg: Agg) {
    loop {
        std::thread::sleep(Duration::from_millis(FLUSH_MS));
        let drained: Vec<((String, String), (u64, u64))> = {
            let mut map = agg.lock().unwrap();
            if map.is_empty() {
                continue;
            }
            map.drain().collect()
        };
        let events: Vec<serde_json::Value> = drained
            .iter()
            .map(|((transport, channel), (count, bytes))| {
                serde_json::json!([transport, channel, count, bytes])
            })
            .collect();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let value = serde_json::json!({"kind":"packets","t":now,"events":events});
        emit(&value.to_string());
    }
}

fn lcm_loop(agg: Agg) -> std::io::Result<()> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    let bind_addr: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, LCM_PORT).into();
    socket.bind(&bind_addr.into())?;
    // IGMP-join on the default interface — required to receive multicast, incl.
    // ttl=0 loopback traffic from local dimos runs.
    socket.join_multicast_v4(&LCM_GROUP, &Ipv4Addr::UNSPECIFIED)?;
    let udp: std::net::UdpSocket = socket.into();

    let mut buf = [0u8; 65535];
    loop {
        let received = match udp.recv_from(&mut buf) {
            Ok((count, _addr)) => count,
            Err(_) => continue,
        };
        let packet = &buf[..received];
        if received < SHORT_HEADER_SIZE {
            continue;
        }
        let magic = be_u32(packet, 0);
        if magic == MAGIC_SHORT {
            let start = SHORT_HEADER_SIZE;
            if let Some(rel) = packet[start..].iter().position(|&byte| byte == 0) {
                let end = start + rel;
                if let Ok(channel) = std::str::from_utf8(&packet[start..end]) {
                    let payload = &packet[end + 1..];
                    record(&agg, "lcm", channel, payload.len() as u64);
                    if channel.contains("resource_stats") {
                        emit_raw("lcm", channel, payload);
                    }
                }
            }
        } else if magic == MAGIC_LONG {
            if received < FRAGMENT_HEADER_SIZE {
                continue;
            }
            // Count each fragmented message once, on its first fragment, using the
            // advertised total payload size. Reassembly isn't needed for metadata.
            if be_u16(packet, 16) != 0 {
                continue;
            }
            let payload_size = be_u32(packet, 8) as u64;
            let start = FRAGMENT_HEADER_SIZE;
            if let Some(rel) = packet[start..].iter().position(|&byte| byte == 0) {
                let end = start + rel;
                if let Ok(channel) = std::str::from_utf8(&packet[start..end]) {
                    record(&agg, "lcm", channel, payload_size);
                }
            }
        }
    }
}

async fn start_zenoh(agg: Agg) -> Option<zenoh::Session> {
    let session = match zenoh::open(zenoh::Config::default()).await {
        Ok(session) => session,
        Err(err) => {
            eprintln!("spy: zenoh open failed (continuing LCM-only): {err}");
            return None;
        }
    };
    let subscriber = session
        .declare_subscriber("**")
        .callback(move |sample| {
            let channel = sample.key_expr().as_str().to_string();
            let payload = sample.payload();
            record(&agg, "zenoh", &channel, payload.len() as u64);
            if channel.contains("resource_stats") {
                emit_raw("zenoh", &channel, &payload.to_bytes());
            }
        })
        .await;
    match subscriber {
        // Leak the subscriber so it lives for the whole process (dropping it would
        // undeclare). The process is killed by the launcher on app stop.
        Ok(sub) => {
            Box::leak(Box::new(sub));
        }
        Err(err) => eprintln!("spy: zenoh subscribe failed: {err}"),
    }
    Some(session)
}

#[tokio::main]
async fn main() {
    let agg: Agg = Arc::new(Mutex::new(HashMap::new()));

    {
        let agg = agg.clone();
        std::thread::spawn(move || flush_loop(agg));
    }
    {
        let agg = agg.clone();
        std::thread::spawn(move || {
            if let Err(err) = lcm_loop(agg) {
                eprintln!("spy: lcm error: {err}");
            }
        });
    }

    // Keep the session alive for the process lifetime.
    let _session = start_zenoh(agg.clone()).await;

    std::future::pending::<()>().await;
}
