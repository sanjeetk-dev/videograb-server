import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import crypto from "crypto";
import NodeCache from "node-cache";
import { Bot, Context, webhookCallback } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { sequentialize } from "@grammyjs/runner";
import { CronJob } from "cron";

import { File } from "./models/file.model.js";
import { connectDB } from "./db/index.js";

/* ---------------- App Setup ---------------- */

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8000;

/* ---------------- Bot Setup ---------------- */

const bot = new Bot<Context>(process.env.BOT_TOKEN!);
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry());
bot.use(sequentialize(ctx => String(ctx.from?.id)));

/* ---------------- Caches ---------------- */

const fileIdCache = new Map<string, string>();

const filesCache = new NodeCache({
    stdTTL: 60 * 5, // 5 minutes
    checkperiod: 120,
});

/* ---------------- Helpers ---------------- */

function UUID(): string {
    return crypto.randomUUID();
}

function generateThumbnailPath(): string {
    return `thumbnails/${UUID()}.jpg`;
}

async function downloadTelegramFile(file_id: string): Promise<Buffer> {
    const file = await bot.api.getFile(file_id);
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to download Telegram file");

    return Buffer.from(await res.arrayBuffer());
}

async function uploadToGitHub(buffer: Buffer, path: string): Promise<string> {
    const res = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/contents/${path}`,
        {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                message: `Upload thumbnail ${path}`,
                content: buffer.toString("base64"),
                branch: process.env.GITHUB_BRANCH || "main",
            }),
        }
    );

    if (!res.ok) throw new Error("GitHub upload failed");

    return `https://raw.githubusercontent.com/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/${process.env.GITHUB_BRANCH || "main"}/${path}`;
}

/* ---------------- Bot Commands ---------------- */

bot.command("start", async (ctx) => {
    try {
        const telegramId = ctx.from?.id;
        const payload = ctx.match;

        if (!payload) {
            await ctx.reply(
                `👋 <b>Welcome to Video Downloader</b>\n\n` +
                `Visit 👉 <a href="https://my-web.com">Video Downloader</a>`,
                { parse_mode: "HTML" }
            );
            return;
        }

        const id = payload.trim().replace(/^video_/, "");
        if (!id) {
            await ctx.reply("❌ Invalid video link.");
            return;
        }

        let file_id = fileIdCache.get(id);

        if (!file_id) {
            const file = await File.findById(id).lean();
            if (!file) {
                await ctx.reply("⚠️ Video not available.");
                return;
            }
            file_id = file.file_id;
            fileIdCache.set(id, file_id);
        }

        await ctx.reply("🎬 <b>Your video is ready!</b>", { parse_mode: "HTML" });
        await bot.api.sendVideo(telegramId!, file_id);

    } catch (err) {
        console.error(err);
        await ctx.reply("🚫 Something went wrong. Try again later.");
    }
});

/* ---------------- Admin Upload ---------------- */

bot.on(":video", async (ctx) => {
    try {
        if (String(ctx.from?.id) !== String(process.env.ADMIN_ID)) {
            await ctx.deleteMessage();
            await ctx.reply("❌ Only admin can upload videos.");
            return;
        }

        const video = ctx.message?.video;
        if (!video) return;

        const title = ctx.message?.caption?.trim() || "Untitled Video";
        const file_id = video.file_id;

        const thumbnail =
            video.thumbnail ??
            null;

        let thumbnail_url = "";

        if (thumbnail) {
            const buffer = await downloadTelegramFile(thumbnail.file_id);
            thumbnail_url = await uploadToGitHub(buffer, generateThumbnailPath());
        }

        const file = await File.create({
            title,
            file_id,
            thumbnail: thumbnail_url,
        });

        filesCache.flushAll(); // invalidate pagination cache

        await ctx.reply(
            `✅ <b>Uploaded Successfully</b>\n\n` +
            `📌 <b>Title:</b> ${title}\n` +
            `🆔 <b>ID:</b> <code>${file._id}</code>\n` +
            `🖼️ <a href="${thumbnail_url}">View Thumbnail</a>`,
            { parse_mode: "HTML" }
        );

    } catch (err) {
        console.error(err);
        await ctx.reply("🚫 Upload failed.");
    }
});

/* ---------------- API Routes ---------------- */

app.get("/", (_, res) => {
    res.json({ status: "ok" });
});

app.get("/api/files", async (req, res) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = 30;
        const skip = (page - 1) * limit;

        const cacheKey = `files_${page}`;
        const cached = filesCache.get(cacheKey);

        if (cached) return res.json(cached);

        const [files, total] = await Promise.all([
            File.find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            File.countDocuments(),
        ]);

        const response = {
            success: true,
            page,
            perPage: limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: files,
        };

        filesCache.set(cacheKey, response);
        res.json(response);

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

/* ---------------- Webhook ---------------- */

app.post(`/${process.env.BOT_TOKEN}`, webhookCallback(bot, "express"));

/* ---------------- Start Server ---------------- */

connectDB().then(async () => {
    app.listen(PORT, async () => {
        await bot.init();
        await bot.api.setWebhook(
            `${process.env.RENDER_EXTERNAL_URL}/${process.env.BOT_TOKEN}`
        );

        console.log(`🚀 Server running on port ${PORT}`);

        // keep-alive ping
        new CronJob("*/10 * * * *", async () => {
            await fetch(process.env.RENDER_EXTERNAL_URL!);
        }, null, true);
    });
}).catch(() => process.exit(1));
