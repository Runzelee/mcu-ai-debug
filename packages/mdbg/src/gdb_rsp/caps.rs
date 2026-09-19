// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! What a `qSupported` exchange told us about the gdb-server, and what we are
//! therefore allowed to do.
//!
//! The multiplexer learns all of this by **watching GDB's own negotiation** —
//! we never send a `qSupported` of our own (`docs-internal/gdb-rsp.md` §4.5), so
//! this type is populated from an observed reply, not from a probe.

/// GDB's baseline when a stub advertises no `PacketSize`: `remote_packet_size =
/// 400 - 1` in `gdb/remote.c`. Deliberately small; almost every real stub
/// advertises something larger.
pub const DEFAULT_PACKET_SIZE: usize = 399;

/// GDB's `MIN_MEMORY_PACKET_SIZE`. A stub advertising less than this gets
/// clamped up — at 20 bytes there is still room to write one byte, which is the
/// floor GDB guarantees itself.
pub const MIN_PACKET_SIZE: usize = 20;

/// Room reserved for a write packet's own header (`M<addr>,<len>:`) when sizing
/// a chunk. Generous: a 64-bit address and length in hex is at most 16 + 16
/// characters plus three punctuation bytes.
const WRITE_HEADER_RESERVE: usize = 40;

/// How this connection should read memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryReadKind {
    /// `m addr,len` — hex reply, two characters per byte. Mandatory for every
    /// stub, so this is the default: assuming `x` and being wrong costs a
    /// failed read, assuming `m` and being wrong costs only bandwidth.
    #[default]
    Hex,
    /// `x addr,len` — reply is `b` followed by escaped binary. Optional,
    /// advertised as `binary-upload+`.
    Binary,
}

/// How this connection should write memory. Mirrors [`MemoryReadKind`]; `X` is
/// gated on the same `binary-upload` feature in practice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MemoryWriteKind {
    /// `M addr,len:<hex>`.
    #[default]
    Hex,
    /// `X addr,len:<escaped binary>`.
    Binary,
}

/// What Agent-side features this server can support.
///
/// Three values, not a yes/no blacklist: `HaltedOnly` is genuinely useful (flush
/// RTT on stop, read state on halt) and saying so beats appearing broken. See
/// `docs-internal/gdb-rsp.md` §7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServerTier {
    /// Answers state-free requests while the target runs. Everything works.
    Full,
    /// Answers only while halted. The send gate blocks while running.
    HaltedOnly,
    /// Mishandles interleaved packets, or breaks GDB's session. Agent-side
    /// features off entirely.
    Unsupported,
    /// Not yet determined for this server type.
    ///
    /// **Provisionally** treated as `HaltedOnly` by the send gate — the
    /// conservative reading, since a request issued while running is the one that
    /// can destabilise a session. Once the compatibility matrix
    /// (`docs-internal/gdb-rsp.md` §7, Phase 3 item 17) has measured five or so
    /// servers, the right default is whatever proves *common*: if nearly all of
    /// them answer while running, this pessimism costs features for no benefit.
    /// Revisiting it means changing [`ServerTier::allows_while_running`] and its
    /// test, and nothing else.
    #[default]
    Unknown,
}

impl ServerTier {
    /// Whether the send gate may issue a request while the target is running.
    pub fn allows_while_running(self) -> bool {
        self == ServerTier::Full
    }

    /// Whether Agent-side features may run at all.
    pub fn allows_anything(self) -> bool {
        !matches!(self, ServerTier::Unsupported)
    }
}

/// Everything the `qSupported` exchange told us.
#[derive(Debug, Clone, Default)]
pub struct RspCaps {
    /// `PacketSize=<hex>`, if advertised. Use [`RspCaps::packet_size`] rather
    /// than this: it applies the default and the floor.
    advertised_packet_size: Option<usize>,
    /// `binary-upload+` — the `x` packet (and in practice `X`) is available.
    pub binary_upload: bool,
    /// `vContSupported+`.
    pub vcont_supported: bool,
    /// `QNonStop+`. Recorded for completeness; this design does not use non-stop
    /// mode (`docs-internal/gdb-rsp.md` §2).
    pub non_stop_supported: bool,
    /// `QStartNoAckMode+` — the stub *offers* no-ack mode. Whether it is in
    /// effect is connection state, tracked by the codec's [`super::AckMode`],
    /// not by this flag.
    pub no_ack_offered: bool,
    /// `multiprocess+`.
    pub multiprocess: bool,
    /// Every feature token verbatim, in the order the stub sent them, so a later
    /// need does not require changing this struct.
    pub raw: Vec<String>,
}

impl RspCaps {
    /// Parse a `qSupported` **reply** payload — the stub's answer, not GDB's
    /// request. Unknown features are kept in `raw` and otherwise ignored, which
    /// is what the protocol requires of any reader.
    pub fn parse_reply(payload: &str) -> Self {
        let mut caps = Self::default();
        for token in payload.split(';').filter(|t| !t.is_empty()) {
            caps.raw.push(token.to_string());
            if let Some((name, value)) = token.split_once('=') {
                if name == "PacketSize" {
                    // Hex, no `0x` prefix. A stub that sends something
                    // unparseable gets the default rather than a panic.
                    caps.advertised_packet_size = usize::from_str_radix(value, 16).ok();
                }
                continue;
            }
            // `name+` supported, `name-` not, `name?` maybe. Only `+` counts as
            // yes; `?` means "ask me", which for our read-only purposes is a no.
            let Some(name) = token.strip_suffix('+') else { continue };
            match name {
                "binary-upload" => caps.binary_upload = true,
                "vContSupported" => caps.vcont_supported = true,
                "QNonStop" => caps.non_stop_supported = true,
                "QStartNoAckMode" => caps.no_ack_offered = true,
                "multiprocess" => caps.multiprocess = true,
                _ => {}
            }
        }
        caps
    }

    /// Look up any feature by name, for things this struct has no field for.
    /// Returns the value for `name=value`, or an empty string for a bare
    /// `name+`. `None` when the feature was not mentioned or was negated.
    pub fn feature(&self, name: &str) -> Option<&str> {
        self.raw.iter().find_map(|token| {
            if let Some((n, v)) = token.split_once('=') {
                return (n == name).then_some(v);
            }
            token.strip_suffix('+').filter(|n| *n == name).map(|_| "")
        })
    }

    /// Whether `PacketSize` was actually advertised, as opposed to defaulted.
    /// Worth logging once per session: a stub that advertises nothing is being
    /// driven at 399 bytes and may be much faster than that.
    pub fn packet_size_was_advertised(&self) -> bool {
        self.advertised_packet_size.is_some()
    }

    /// Usable packet payload size: what the stub advertised, or GDB's default,
    /// clamped up to GDB's minimum.
    pub fn packet_size(&self) -> usize {
        self.advertised_packet_size
            .unwrap_or(DEFAULT_PACKET_SIZE)
            .max(MIN_PACKET_SIZE)
    }

    /// Largest number of target bytes to request in one read.
    ///
    /// Halved, matching `remote_read_bytes_1`'s `(buf_size / unit_size) / 2`.
    /// The halving exists because `m` answers in hex, two characters per byte;
    /// GDB applies it to `x` as well rather than tracking two limits, and so do
    /// we — correct for `m`, safely conservative for `x`, one less thing to get
    /// wrong per server.
    pub fn max_read_bytes(&self) -> usize {
        (self.packet_size() / 2).max(1)
    }

    /// Largest number of target bytes to send in one write.
    ///
    /// Same halving as reads, after reserving room for the packet's own
    /// `M<addr>,<len>:` header — which a read does not have to carry in the same
    /// buffer as its data. Strictly more conservative than GDB, so the only
    /// consequence of the reserve being too generous is an extra chunk.
    pub fn max_write_bytes(&self) -> usize {
        (self.packet_size().saturating_sub(WRITE_HEADER_RESERVE) / 2).max(1)
    }

    pub fn memory_read_kind(&self) -> MemoryReadKind {
        if self.binary_upload {
            MemoryReadKind::Binary
        } else {
            MemoryReadKind::Hex
        }
    }

    pub fn memory_write_kind(&self) -> MemoryWriteKind {
        if self.binary_upload {
            MemoryWriteKind::Binary
        } else {
            MemoryWriteKind::Hex
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenOCD's reply, transcribed from the `xml_printf` format string in
    /// `src/server/gdb_server.c` (the `qSupported` handler) with both optional
    /// features enabled. `PacketSize` is `GDB_BUFFER_SIZE` = 16384 = 0x4000.
    ///
    /// Note what is **absent**: no `binary-upload+`, because OpenOCD does not
    /// implement the `x` packet at all — there is no `case 'x'` in its dispatch.
    /// Memory reads against OpenOCD are hex, two characters per target byte.
    const OPENOCD: &str = "PacketSize=4000;qXfer:memory-map:read+;qXfer:features:read+;\
                           qXfer:threads:read+;QStartNoAckMode+;vContSupported+";

    #[test]
    fn parses_openocds_reply() {
        let caps = RspCaps::parse_reply(OPENOCD);
        assert_eq!(caps.packet_size(), 16384);
        assert!(caps.packet_size_was_advertised());
        assert!(caps.vcont_supported);
        assert!(caps.no_ack_offered);
        assert!(!caps.non_stop_supported);
        assert!(!caps.multiprocess);
        // The one that matters for read sizing: OpenOCD has no `x`, so `m` it is.
        assert!(!caps.binary_upload);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
        // 16384 / 2 -- and for a hex-only server the halving is exactly right
        // rather than merely conservative.
        assert_eq!(caps.max_read_bytes(), 8192);
    }

    #[test]
    fn parses_a_reply_that_does_advertise_binary_upload() {
        // Not OpenOCD. Kept separate so the OpenOCD fixture stays honest.
        let caps = RspCaps::parse_reply("PacketSize=1000;QStartNoAckMode+;binary-upload+;multiprocess+");
        assert!(caps.binary_upload);
        assert!(caps.multiprocess);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Binary);
        assert_eq!(caps.memory_write_kind(), MemoryWriteKind::Binary);
    }

    #[test]
    fn parses_a_minimal_reply() {
        // A stub may answer with nothing at all; everything must default safely.
        let caps = RspCaps::parse_reply("");
        assert!(!caps.packet_size_was_advertised());
        assert_eq!(caps.packet_size(), DEFAULT_PACKET_SIZE);
        assert!(!caps.binary_upload);
        // The important default: `m`, which every stub implements.
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
        assert_eq!(caps.memory_write_kind(), MemoryWriteKind::Hex);
    }

    #[test]
    fn parses_a_jlink_style_reply_without_binary_upload() {
        let caps = RspCaps::parse_reply("PacketSize=1000;qXfer:memory-map:read-;QStartNoAckMode+;swbreak+");
        assert_eq!(caps.packet_size(), 0x1000);
        assert!(!caps.binary_upload);
        assert_eq!(caps.memory_read_kind(), MemoryReadKind::Hex);
    }

    #[test]
    fn negated_and_maybe_features_are_not_treated_as_supported() {
        // `-` is an explicit no; `?` means "query me", which is not a yes.
        let caps = RspCaps::parse_reply("binary-upload-;QNonStop?;vContSupported+");
        assert!(!caps.binary_upload);
        assert!(!caps.non_stop_supported);
        assert!(caps.vcont_supported);
    }

    #[test]
    fn unknown_features_are_retained_verbatim() {
        let caps = RspCaps::parse_reply("PacketSize=100;some-future-thing+;another=42");
        assert!(caps.raw.contains(&"some-future-thing+".to_string()));
        assert_eq!(caps.feature("some-future-thing"), Some(""));
        assert_eq!(caps.feature("another"), Some("42"));
        assert_eq!(caps.feature("nonexistent"), None);
    }

    #[test]
    fn unparseable_packet_size_falls_back_to_the_default() {
        // Must not panic and must not end up with a nonsense size.
        let caps = RspCaps::parse_reply("PacketSize=notahexnumber;binary-upload+");
        assert_eq!(caps.packet_size(), DEFAULT_PACKET_SIZE);
        // Parsing continues past the bad token.
        assert!(caps.binary_upload);
    }

    #[test]
    fn tiny_advertised_packet_size_is_clamped_up() {
        let caps = RspCaps::parse_reply("PacketSize=4");
        assert_eq!(caps.packet_size(), MIN_PACKET_SIZE);
        // A read must still be for at least one byte.
        assert!(caps.max_read_bytes() >= 1);
        assert!(caps.max_write_bytes() >= 1);
    }

    #[test]
    fn read_budget_is_half_the_packet_size() {
        // The `/ 2` from remote_read_bytes_1. Getting this wrong means either
        // truncated replies or needlessly many round trips.
        let caps = RspCaps::parse_reply("PacketSize=1000");
        assert_eq!(caps.max_read_bytes(), 0x800);
    }

    #[test]
    fn write_budget_leaves_room_for_the_packet_header() {
        let caps = RspCaps::parse_reply("PacketSize=1000");
        assert!(
            caps.max_write_bytes() < caps.max_read_bytes(),
            "writes must reserve header room that reads do not"
        );
        assert_eq!(caps.max_write_bytes(), (0x1000 - WRITE_HEADER_RESERVE) / 2);
    }

    #[test]
    fn tier_gating() {
        assert!(ServerTier::Full.allows_while_running());
        assert!(!ServerTier::HaltedOnly.allows_while_running());
        // An undetermined server is treated as halted-only, not as Full: issuing
        // a request while running is the move that can destabilise a session.
        assert!(!ServerTier::Unknown.allows_while_running());
        assert!(ServerTier::Unknown.allows_anything());
        assert!(!ServerTier::Unsupported.allows_anything());
        assert!(!ServerTier::Unsupported.allows_while_running());
        // The default must be the conservative one.
        assert_eq!(ServerTier::default(), ServerTier::Unknown);
    }
}
