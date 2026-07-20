import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError } from "@github/copilot-sdk/extension";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const artifactsDirectory = join(extensionDirectory, "artifacts");
const notePath = join(artifactsDirectory, "scratchpad.md");
const legacyDataPath = join(artifactsDirectory, "scratchpad.json");
const maximumNoteLength = 1_000_000;
let mutationQueue = Promise.resolve();

async function readOptional(path) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

function legacyEntryToMarkdown(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new CanvasError("migration_failed", "The previous scratchpad contains an invalid entry.");
    }

    const title = typeof entry.title === "string" && entry.title.trim()
        ? entry.title.trim()
        : "Untitled note";
    const body = typeof entry.body === "string" ? entry.body.trim() : "";
    const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => `#${tag.trim()}`)
        : [];
    const source = entry.source && typeof entry.source === "object" && !Array.isArray(entry.source)
        ? entry.source
        : null;
    const metadata = [];

    if (tags.length > 0) {
        metadata.push(`Tags: ${tags.join(" ")}`);
    }
    if (source?.project) {
        metadata.push(`Project: ${source.project}`);
    }
    if (source?.url) {
        metadata.push(`Source: [${source.label || source.url}](${source.url})`);
    } else if (source?.label) {
        metadata.push(`Source: ${source.label}`);
    }

    return [
        `## ${title}`,
        body,
        metadata.length > 0 ? metadata.join("\n") : "",
    ].filter(Boolean).join("\n\n");
}

async function migrateLegacyData() {
    const legacyRaw = await readOptional(legacyDataPath);
    if (legacyRaw === null) {
        return "";
    }

    let parsed;
    try {
        parsed = JSON.parse(legacyRaw);
    } catch {
        throw new CanvasError(
            "migration_failed",
            `The previous scratchpad data at ${legacyDataPath} is not valid JSON.`,
        );
    }
    if (!Array.isArray(parsed?.entries)) {
        throw new CanvasError("migration_failed", "The previous scratchpad data format is invalid.");
    }
    if (parsed.entries.length === 0) {
        return "";
    }

    const entries = [...parsed.entries].sort((left, right) =>
        String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
    );
    return [
        "# Scratchpad",
        entries.map(legacyEntryToMarkdown).join("\n\n---\n\n"),
    ].join("\n\n");
}

async function ensureNote() {
    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const existing = await readOptional(notePath);
    if (existing !== null) {
        return existing;
    }

    const migrated = await migrateLegacyData();
    await saveContent(migrated);
    return migrated;
}

async function saveContent(content) {
    if (typeof content !== "string") {
        throw new CanvasError("invalid_note", "Scratchpad content must be text.");
    }
    if (content.length > maximumNoteLength) {
        throw new CanvasError("note_too_large", "The scratchpad note is limited to 1 MB.");
    }

    await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${notePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, notePath);
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw new CanvasError("storage_write_failed", `Scratchpad could not be saved: ${error.message}`);
    }
}

function mutate(callback) {
    const operation = mutationQueue.then(async () => {
        const content = await ensureNote();
        const nextContent = await callback(content);
        await saveContent(nextContent);
        return readNote();
    });
    mutationQueue = operation.catch(() => {});
    return operation;
}

export async function readNote() {
    let content;
    try {
        content = await ensureNote();
    } catch (error) {
        if (error instanceof CanvasError) {
            throw error;
        }
        throw new CanvasError("storage_read_failed", `Scratchpad could not be read: ${error.message}`);
    }

    const fileStat = await stat(notePath);
    return {
        content,
        updatedAt: fileStat.mtime.toISOString(),
    };
}

export async function replaceNote(content) {
    return mutate(() => content);
}

export async function appendNote(content) {
    if (typeof content !== "string" || !content.trim()) {
        throw new CanvasError("invalid_note", "Text is required to append to the scratchpad.");
    }
    return mutate((current) => {
        if (!current.trim()) {
            return content.trim();
        }
        return `${current.replace(/\s+$/, "")}\n\n${content.trim()}\n`;
    });
}
