(() => {
    "use strict";

    const basePath = document.querySelector('meta[name="scratchpad-base"]').content;
    const state = {
        content: "",
        lastSavedContent: "",
        mode: window.innerWidth < 760 ? "edit" : "split",
        saveTimer: 0,
        saveQueue: Promise.resolve(),
        pendingSaves: 0,
        applyingRemoteUpdate: false,
    };
    const app = document.getElementById("app");

    function element(tag, options = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(options)) {
            if (key === "className") {
                node.className = value;
            } else if (key === "text") {
                node.textContent = value;
            } else if (key.startsWith("on") && typeof value === "function") {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (value !== undefined && value !== null) {
                node.setAttribute(key, String(value));
            }
        }
        for (const child of children) {
            if (child) {
                node.append(child);
            }
        }
        return node;
    }

    async function request(path, options = {}) {
        const response = await fetch(`${basePath}${path}`, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers ?? {}),
            },
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.message || "Scratchpad request failed.");
        }
        return payload;
    }

    function showToast(message, isError = false) {
        document.querySelector(".toast")?.remove();
        const toast = element("div", {
            className: `toast${isError ? " error" : ""}`,
            role: "status",
            text: message,
        });
        document.body.append(toast);
        window.setTimeout(() => toast.remove(), 3200);
    }

    function safeLinkTarget(rawUrl) {
        try {
            const url = new URL(rawUrl, window.location.href);
            return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
        } catch {
            return null;
        }
    }

    function appendInline(parent, text) {
        const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^) \n]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
        let cursor = 0;
        for (const match of text.matchAll(tokenPattern)) {
            if (match.index > cursor) {
                parent.append(document.createTextNode(text.slice(cursor, match.index)));
            }
            const token = match[0];
            if (token.startsWith("`")) {
                parent.append(element("code", { text: token.slice(1, -1) }));
            } else if (token.startsWith("**") || token.startsWith("__")) {
                parent.append(element("strong", { text: token.slice(2, -2) }));
            } else if (token.startsWith("~~")) {
                parent.append(element("del", { text: token.slice(2, -2) }));
            } else if (token.startsWith("[")) {
                const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
                const href = linkMatch ? safeLinkTarget(linkMatch[2]) : null;
                if (linkMatch && href) {
                    parent.append(element("a", {
                        text: linkMatch[1],
                        href,
                        target: "_blank",
                        rel: "noreferrer",
                    }));
                } else {
                    parent.append(document.createTextNode(token));
                }
            } else {
                parent.append(element("em", { text: token.slice(1, -1) }));
            }
            cursor = match.index + token.length;
        }
        if (cursor < text.length) {
            parent.append(document.createTextNode(text.slice(cursor)));
        }
    }

    function startsBlock(line) {
        return /^(#{1,6})\s+|^```|^\s*([-*_])(?:\s*\1){2,}\s*$|^>\s?|^\s*[-+*]\s+|^\s*\d+\.\s+/.test(line);
    }

    function renderMarkdown(markdown, container) {
        container.replaceChildren();
        if (!markdown.trim()) {
            container.append(element("div", { className: "markdown-empty" }, [
                element("span", { text: "Personal note" }),
                element("h2", { text: "Start in Markdown." }),
                element("p", {
                    text: "Capture unfinished thinking here. It stays personal and follows you across projects.",
                }),
            ]));
            return;
        }

        const lines = markdown.replace(/\r\n/g, "\n").split("\n");
        let index = 0;
        while (index < lines.length) {
            const line = lines[index];
            if (!line.trim()) {
                index += 1;
                continue;
            }

            const fence = /^```([\w-]*)\s*$/.exec(line);
            if (fence) {
                const codeLines = [];
                index += 1;
                while (index < lines.length && !/^```\s*$/.test(lines[index])) {
                    codeLines.push(lines[index]);
                    index += 1;
                }
                if (index < lines.length) {
                    index += 1;
                }
                const code = element("code", { text: codeLines.join("\n") });
                if (fence[1]) {
                    code.className = `language-${fence[1]}`;
                }
                container.append(element("pre", {}, [code]));
                continue;
            }

            const heading = /^(#{1,6})\s+(.+)$/.exec(line);
            if (heading) {
                const node = element(`h${heading[1].length}`);
                appendInline(node, heading[2]);
                container.append(node);
                index += 1;
                continue;
            }

            if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
                container.append(element("hr"));
                index += 1;
                continue;
            }

            if (/^>\s?/.test(line)) {
                const quoteLines = [];
                while (index < lines.length && /^>\s?/.test(lines[index])) {
                    quoteLines.push(lines[index].replace(/^>\s?/, ""));
                    index += 1;
                }
                const quote = element("blockquote");
                appendInline(quote, quoteLines.join("\n"));
                container.append(quote);
                continue;
            }

            const unordered = /^\s*[-+*]\s+/.test(line);
            const ordered = /^\s*\d+\.\s+/.test(line);
            if (unordered || ordered) {
                const list = element(ordered ? "ol" : "ul");
                const itemPattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
                while (index < lines.length) {
                    const itemMatch = itemPattern.exec(lines[index]);
                    if (!itemMatch) {
                        break;
                    }
                    const itemText = itemMatch[1];
                    const task = /^\[([ xX])\]\s+(.+)$/.exec(itemText);
                    const item = element("li", task ? { className: "task-item" } : {});
                    if (task) {
                        item.append(element("input", {
                            type: "checkbox",
                            disabled: "",
                            ...(task[1].toLocaleLowerCase() === "x" ? { checked: "" } : {}),
                        }));
                        appendInline(item, task[2]);
                    } else {
                        appendInline(item, itemText);
                    }
                    list.append(item);
                    index += 1;
                }
                container.append(list);
                continue;
            }

            const paragraphLines = [line];
            index += 1;
            while (
                index < lines.length
                && lines[index].trim()
                && !startsBlock(lines[index])
            ) {
                paragraphLines.push(lines[index]);
                index += 1;
            }
            const paragraph = element("p");
            paragraphLines.forEach((paragraphLine, lineIndex) => {
                if (lineIndex > 0) {
                    paragraph.append(document.createTextNode(" "));
                }
                appendInline(paragraph, paragraphLine);
            });
            container.append(paragraph);
        }
    }

    function updatePreview() {
        const preview = document.querySelector(".markdown");
        if (preview) {
            renderMarkdown(state.content, preview);
        }
    }

    function updateSaveStatus(text) {
        const status = document.querySelector(".save-status");
        if (status) {
            status.textContent = text;
        }
    }

    function scheduleSave() {
        window.clearTimeout(state.saveTimer);
        updateSaveStatus("Unsaved");
        state.saveTimer = window.setTimeout(save, 500);
    }

    function save() {
        window.clearTimeout(state.saveTimer);
        const content = state.content;
        if (content === state.lastSavedContent) {
            updateSaveStatus("Saved");
            return state.saveQueue;
        }

        state.pendingSaves += 1;
        const operation = async () => {
            updateSaveStatus("Saving");
            try {
                const note = await request("api/note", {
                    method: "PUT",
                    body: JSON.stringify({ content }),
                });
                state.lastSavedContent = content;
                if (state.content === content) {
                    updateSaveStatus("Saved");
                }
                return note;
            } catch (error) {
                updateSaveStatus("Save failed");
                showToast(error.message, true);
                return null;
            } finally {
                state.pendingSaves -= 1;
            }
        };

        const queued = state.saveQueue.then(operation, operation);
        state.saveQueue = queued.catch(() => {});
        return queued;
    }

    function setMode(mode) {
        state.mode = mode;
        const page = document.querySelector(".page");
        if (page) {
            page.dataset.mode = mode;
        }
        for (const button of document.querySelectorAll(".mode-button")) {
            button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
        }
        if (mode !== "edit") {
            updatePreview();
        }
    }

    async function sendToChat() {
        await save();
        const editor = document.querySelector(".editor");
        const selection = editor.value.substring(editor.selectionStart, editor.selectionEnd);
        try {
            await request("api/send", {
                method: "POST",
                body: JSON.stringify({ selection }),
            });
            showToast(selection ? "Selection sent to chat." : "Scratchpad sent to chat.");
        } catch (error) {
            showToast(error.message, true);
        }
    }

    function buildModeButton(label, mode) {
        return element("button", {
            className: "mode-button",
            type: "button",
            text: label,
            "data-mode": mode,
            "aria-pressed": String(state.mode === mode),
            onclick: () => setMode(mode),
        });
    }

    function render() {
        const editor = element("textarea", {
            className: "editor",
            placeholder: "# Scratchpad\n\nWrite in Markdown…",
            "aria-label": "Markdown scratchpad",
            spellcheck: "true",
            oninput: (event) => {
                state.content = event.target.value;
                updatePreview();
                scheduleSave();
            },
        });
        editor.value = state.content;

        const preview = element("article", {
            className: "markdown",
            "aria-label": "Markdown preview",
        });
        renderMarkdown(state.content, preview);

        const toolbar = element("header", { className: "toolbar" }, [
            element("div", { className: "identity" }, [
                element("h1", { text: "Scratchpad" }),
                element("span", { className: "personal-mark", text: "Personal" }),
            ]),
            element("div", { className: "mode-switcher", role: "group", "aria-label": "View mode" }, [
                buildModeButton("Edit", "edit"),
                buildModeButton("Split", "split"),
                buildModeButton("Preview", "preview"),
            ]),
            element("div", { className: "toolbar-actions" }, [
                element("span", { className: "save-status", text: "Saved" }),
                element("button", {
                    className: "send-button",
                    type: "button",
                    text: "Send to chat",
                    onclick: sendToChat,
                }),
            ]),
        ]);
        const page = element("main", { className: "page", "data-mode": state.mode }, [
            element("section", { className: "pane editor-pane", "aria-label": "Editor" }, [editor]),
            element("section", { className: "pane preview-pane", "aria-label": "Preview" }, [preview]),
        ]);

        app.replaceChildren(element("div", { className: "canvas" }, [toolbar, page]));
    }

    async function refreshFromStore() {
        if (state.pendingSaves > 0 || state.content !== state.lastSavedContent) {
            return;
        }
        try {
            const note = await request("api/note");
            if (note.content === state.content) {
                return;
            }
            state.applyingRemoteUpdate = true;
            state.content = note.content;
            state.lastSavedContent = note.content;
            const editor = document.querySelector(".editor");
            if (editor) {
                const selectionStart = editor.selectionStart;
                editor.value = note.content;
                editor.setSelectionRange(
                    Math.min(selectionStart, note.content.length),
                    Math.min(selectionStart, note.content.length),
                );
            }
            updatePreview();
            updateSaveStatus("Updated");
        } catch (error) {
            showToast(error.message, true);
        } finally {
            state.applyingRemoteUpdate = false;
        }
    }

    async function bootstrap() {
        try {
            const note = await request("api/note");
            state.content = note.content;
            state.lastSavedContent = note.content;
            render();
        } catch (error) {
            app.replaceChildren(element("div", { className: "markdown-empty" }, [
                element("h2", { text: "Scratchpad could not open" }),
                element("p", { text: error.message }),
            ]));
            return;
        }

        const events = new EventSource(`${basePath}events`);
        events.addEventListener("refresh", () => window.setTimeout(refreshFromStore, 100));
        events.addEventListener("error", () => {
            showToast("Scratchpad lost its live connection. Reopen it to reconnect.", true);
        });
    }

    document.addEventListener("keydown", (event) => {
        if (!(event.metaKey || event.ctrlKey)) {
            return;
        }
        if (event.key.toLocaleLowerCase() === "s") {
            event.preventDefault();
            save();
        } else if (event.key.toLocaleLowerCase() === "e") {
            event.preventDefault();
            setMode("edit");
        } else if (event.key.toLocaleLowerCase() === "p") {
            event.preventDefault();
            setMode("preview");
        } else if (event.key === "\\") {
            event.preventDefault();
            setMode("split");
        }
    });

    window.addEventListener("beforeunload", () => {
        if (state.content === state.lastSavedContent) {
            return;
        }
        navigator.sendBeacon(
            `${basePath}api/note`,
            new Blob([JSON.stringify({ content: state.content })], { type: "application/json" }),
        );
    });

    bootstrap();
})();
