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

//! Entry point for the proxy-helper subcommand.
//! This will implement the Probe Agent that manages gdb-server processes
//! and speaks the Funnel Protocol over TCP.

use anyhow::Result;
use clap::Args;
use clap::ValueEnum;
use flexi_logger::{Age, Cleanup, Criterion, Duplicate, FileSpec, Logger, LoggerHandle, Naming};
use std::{
    io::Write,
    net::{Ipv4Addr, TcpListener},
    path::PathBuf,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::proxy_helper::proxy_server::ProxyServer;

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum PortWaitMode {
    /// Existing behavior: proactively connect and keep forwarding stream open.
    ConnectHold,
    /// Probe with a connect attempt but do not hold the stream open.
    ConnectProbe,
    /// Non-invasive monitor mode (lsof/netstat) that reports readiness.
    Monitor,
}

#[derive(Args, Debug)]
pub struct ProxyArgs {
    /// Host to listen on (default: 127.0.0.1), alternatively specify `0.0.0.0` to listen on all interfaces
    #[arg(short = 'H', long = "host", default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on (0 = auto-assign)
    #[arg(short = 'p', long = "port", default_value_t = 0)]
    pub port: u16,

    /// Authentication token for client connections
    #[arg(short = 't', long = "token", default_value = "adis-ababa")]
    pub token: String,

    /// Enable debug output
    #[arg(short = 'd', long = "debug", default_value_t = false)]
    pub debug: bool,

    /// Strategy to detect stream-port readiness
    #[arg(long = "port-wait-mode", value_enum, default_value_t = PortWaitMode::ConnectHold)]
    pub port_wait_mode: PortWaitMode,

    /// Also emit log lines to stderr (file logging is always enabled)
    #[arg(long = "log-stderr", default_value_t = false)]
    pub log_stderr: bool,

    /// Directory for proxy-helper log files
    #[arg(long = "log-dir")]
    pub log_dir: Option<String>,
}

fn init_logging(args: &ProxyArgs) -> Result<LoggerHandle> {
    let log_dir = args.log_dir.clone().map(PathBuf::from).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("mcu-debug-helper")
            .join("proxy-logs")
    });

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let launch_id = format!("{}-{}", std::process::id(), ts);

    let logger = Logger::try_with_env_or_str(if args.debug { "debug" } else { "info" })?
        .format(flexi_logger::detailed_format)
        .log_to_file(
            FileSpec::default()
                .directory(log_dir)
                .basename("proxy-helper")
                .discriminant(launch_id)
                .suffix("log"),
        )
        .rotate(
            Criterion::Age(Age::Day),
            Naming::Timestamps,
            Cleanup::KeepLogFiles(14),
        )
        .duplicate_to_stderr(if args.log_stderr {
            Duplicate::All
        } else {
            Duplicate::None
        });

    Ok(logger.start()?)
}

pub fn run(args: ProxyArgs) -> Result<()> {
    let _log_handle = init_logging(&args)?;
    crate::common::debug::set_debug(args.debug);
    log::info!("Port wait mode: {:?}", args.port_wait_mode);
    log::info!(
        "Proxy helper startup: pid={}, host={}, port={}, log_stderr={}",
        std::process::id(),
        args.host,
        args.port,
        args.log_stderr
    );
    // 1. Bind TCP listener (port 0 for auto-assign)

    // TODO: Maybe allow Ipv6 in the future, but for now we can just require IPv4 for simplicity
    let host = match args.host.parse::<Ipv4Addr>() {
        Ok(ip) => ip,
        Err(e) => {
            log::error!("Invalid host IP address: {}", args.host);
            return Err(e.into());
        }
    };
    let listener = match TcpListener::bind((host, args.port)) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Failed to bind to {}:{}", args.host, args.port);
            return Err(e.into());
        }
    };

    // Print Discovery JSON to stdout: {"status": "ready", "port": <actual_port>, "pid": <pid>}
    println!(
        "{{\"status\": \"ready\", \"port\": {}, \"pid\": {}}}",
        listener.local_addr()?.port(),
        std::process::id()
    );
    std::io::stdout().flush()?;

    if args.port == 0 {
        let local_port = listener.local_addr()?.port();
        log::info!("Probe Agent auto-assigned to port {}", local_port);
    } else {
        log::info!("Probe Agent listening on port {}", args.port);
    }

    // For cleanup later
    let mut client_threads = Vec::new();

    // Accept connection and run Funnel Protocol handler in a new thread
    // We generally don't have multiple clients when running inside a VSCode extension,
    // but we have a use case in multi-core debugging where each core needs its own proxy instance,
    // so we should be prepared to handle multiple connections gracefully (e.g. by rejecting
    // them with an error message). We don't need to know why we have multiple connections, we just
    // need to make sure we don't crash or do something weird if it happens.
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // Spawn a new thread to handle each incoming connection
                let args_clone = ProxyArgs {
                    host: args.host.clone(),
                    port: args.port,
                    token: args.token.to_owned(),
                    debug: args.debug,
                    port_wait_mode: args.port_wait_mode,
                    log_stderr: args.log_stderr,
                    log_dir: args.log_dir.clone(),
                };
                let handle = thread::spawn(move || {
                    let mut new_client = ProxyServer::new(args_clone, stream);
                    new_client.message_loop().unwrap_or_else(|e| {
                        log::error!("Error in client message loop: {}", e);
                    });
                });
                client_threads.push(handle);
            }
            Err(e) => {
                log::error!("Connection failed: {}", e);
            }
        }
    }

    Ok(())
}
