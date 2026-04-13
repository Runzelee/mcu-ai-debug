#!/usr/bin/env node

const net = require("net");
const PORT = 51234;

const socket = net.connect(PORT, "127.0.0.1", () => {
    // Pipe standard input (Agent -> Bridge) to socket (Bridge -> Extension)
    process.stdin.pipe(socket);
    // Pipe socket (Extension -> Bridge) to standard output (Bridge -> Agent)
    socket.pipe(process.stdout);
});

socket.on("error", (err) => {
    console.error(`MCP Bridge Error: Could not connect to MCU-Debug on port ${PORT}. Is debugging active?`, err.message);
    process.exit(1);
});

process.on("SIGINT", () => {
    socket.destroy();
    process.exit(0);
});
