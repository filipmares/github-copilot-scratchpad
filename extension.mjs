import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    CanvasError,
    createCanvas,
    joinSession,
} from "@github/copilot-sdk/extension";
import {
    appendNote,
    readNote,
    replaceNote,
} from "./storage.mjs";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const [appCss, appJs] = await Promise.all([
    readFile(join(extensionDirectory, "app.css"), "utf8"),
    readFile(join(extensionDirectory, "app.js"), "utf8"),
]);

const servers = new Map();
const eventClients = new Set();
let session;

function renderHtml(basePath) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="scratchpad-base" content="${basePath}">
    <title>Scratchpad</title>
    <link rel="stylesheet" href="${basePath}app.css">
</head>
<body>
    <div id="app" aria-live="polite"></div>
    <script src="${basePath}app.js" defer></script>
</body>
</html>`;
}

function setSecurityHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", [
        "default-src 'none'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join("; "));
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, status, value) {
    setSecurityHeaders(res);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
}

function sendText(res, status, contentType, value) {
    setSecurityHeaders(res);
    res.statusCode = status;
    res.setHeader("Content-Type", contentType);
    res.end(value);
}

async function readJson(req) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_100_000) {
            throw new CanvasError("payload_too_large", "Scratchpad requests are limited to 1.1 MB.");
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) {
        return {};
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new CanvasError("invalid_json", "The scratchpad request body is not valid JSON.");
    }
}

function broadcastRefresh() {
    for (const res of eventClients) {
        res.write("event: refresh\ndata: {}\n\n");
    }
}

async function startServer(instanceId) {
    const token = randomUUID();
    const basePath = `/${token}/`;

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (!url.pathname.startsWith(basePath)) {
                sendJson(res, 404, { error: "not_found", message: "Scratchpad endpoint not found." });
                return;
            }

            const path = url.pathname.slice(basePath.length);
            if (req.method === "GET" && path === "") {
                sendText(res, 200, "text/html; charset=utf-8", renderHtml(basePath));
                return;
            }
            if (req.method === "GET" && path === "app.css") {
                sendText(res, 200, "text/css; charset=utf-8", appCss);
                return;
            }
            if (req.method === "GET" && path === "app.js") {
                sendText(res, 200, "text/javascript; charset=utf-8", appJs);
                return;
            }
            if (req.method === "GET" && path === "api/note") {
                sendJson(res, 200, await readNote());
                return;
            }
            if ((req.method === "PUT" || req.method === "POST") && path === "api/note") {
                const input = await readJson(req);
                const note = await replaceNote(input.content);
                broadcastRefresh();
                sendJson(res, 200, note);
                return;
            }
            if (req.method === "POST" && path === "api/send") {
                const input = await readJson(req);
                const note = await readNote();
                const content = typeof input.selection === "string" && input.selection.trim()
                    ? input.selection.trim()
                    : note.content.trim();
                if (!content) {
                    throw new CanvasError("empty_note", "Write something before sending the scratchpad to chat.");
                }
                const messageId = await session.send({
                    prompt: `Use this personal scratchpad Markdown as context:\n\n${content}`,
                });
                sendJson(res, 200, { messageId });
                return;
            }
            if (req.method === "GET" && path === "events") {
                setSecurityHeaders(res);
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Connection", "keep-alive");
                res.write(`event: ready\ndata: ${JSON.stringify({ instanceId })}\n\n`);
                eventClients.add(res);
                req.on("close", () => eventClients.delete(res));
                return;
            }

            sendJson(res, 404, { error: "not_found", message: "Scratchpad endpoint not found." });
        } catch (error) {
            const code = error instanceof CanvasError ? error.code : "scratchpad_error";
            const message = error instanceof Error ? error.message : "Scratchpad request failed.";
            const status = code === "payload_too_large"
                ? 413
                : code.startsWith("storage_") || code === "migration_failed" || code === "scratchpad_error"
                    ? 500
                    : 400;
            sendJson(res, status, { error: code, message });
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new CanvasError("server_start_failed", "Scratchpad could not start its local renderer.");
    }

    return {
        server,
        url: `http://127.0.0.1:${address.port}${basePath}`,
    };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "personal-scratchpad",
            displayName: "Scratchpad",
            description: "One private personal Markdown note that persists across projects and sessions.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
            actions: [
                {
                    name: "read_note",
                    description: "Read the user's personal Markdown scratchpad.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {},
                    },
                    handler: async () => readNote(),
                },
                {
                    name: "replace_note",
                    description: "Replace the personal Markdown scratchpad when the user explicitly asks.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["content"],
                        properties: {
                            content: { type: "string", maxLength: 1000000 },
                        },
                    },
                    handler: async (ctx) => {
                        const note = await replaceNote(ctx.input.content);
                        broadcastRefresh();
                        return note;
                    },
                },
                {
                    name: "append_note",
                    description: "Append Markdown when the user explicitly asks to save something to their scratchpad.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["content"],
                        properties: {
                            content: { type: "string", minLength: 1, maxLength: 1000000 },
                        },
                    },
                    handler: async (ctx) => {
                        const note = await appendNote(ctx.input.content);
                        broadcastRefresh();
                        return note;
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "Scratchpad",
                    status: "Personal Markdown · private",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) {
                    return;
                }
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(resolve));
            },
        }),
    ],
});
