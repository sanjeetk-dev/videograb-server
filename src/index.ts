import "dotenv/config";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import fetch from "node-fetch";
import express from "express";
import { Bot, Context, webhookCallback } from "grammy";
import { File } from "./models/file.model";
import { connectDB } from "./db";
import crypto from "crypto";
import NodeCache from "node-cache";
import cors from "cors";
import { CronJob } from "cron";

const app = express();
app.use(cors())
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cache = new Map<string, string>();

const bot = new Bot<Context>(process.env.BOT_TOKEN!);
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry());
bot.use(sequentialize(ctx => String(ctx.from!.id)));

/* ---------- Helpers ---------- */

const filesCache = new NodeCache({
    stdTTL: 60 * 5,      // cache for 60 seconds
    checkperiod: 120,
});


function UUID(): string {
    return crypto.randomUUID();
}

function generateThumbnailPath(): string {
    return `thumbnails/${UUID()}.jpg`;
}

async function downloadTelegramFile(file_id: string): Promise<Buffer> {
    const file = await bot.api.getFile(file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const res = await fetch(fileUrl);
    if (!res.ok) {
        throw new Error("Failed to download Telegram file");
    }

    return Buffer.from(await res.arrayBuffer());
}

async function uploadToGitHub(buffer: Buffer, path: string): Promise<string> {
    const content = buffer.toString("base64");

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
                content,
                branch: process.env.GITHUB_BRANCH || "main",
            }),
        }
    );

    if (!res.ok) {
        throw new Error("Failed to upload thumbnail to GitHub");
    }

    return `https://raw.githubusercontent.com/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/${process.env.GITHUB_BRANCH || "main"}/${path}`;
}

/* ---------- Commands ---------- */

bot.command("start", async (ctx) => {
    try {
        const telegramId = ctx.from?.id;
        const payload = ctx.match;

        if (!payload) {
            await ctx.reply(
                `👋 <b>Welcome to Video Downloader</b>\n\n` +
                `Visit 👉 <a href="https://my-web.com">Video Downloader</a>\n\n` +
                `You’ll be redirected back here automatically.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        const id = payload.trim().replace(/^video_/, "");
        if (!id) {
            await ctx.reply("❌ Invalid or corrupted video link.");
            return;
        }

        let file_id = cache.get(id);

        if (!file_id) {
            const file = await File.findById(id).lean();
            if (!file) {
                await ctx.reply(
                    "⚠️ This video is no longer available.\n\nIt may have been removed or expired."
                );
                return;
            }

            file_id = file.file_id;
            cache.set(id, file_id);
        }

        await ctx.reply("🎬 <b>Your video is ready!</b>", { parse_mode: "HTML" });
        await bot.api.sendVideo(telegramId!, file_id);

    } catch (error) {
        console.error(error);
        await ctx.reply(
            "🚫 Something went wrong while processing your request.\nPlease try again later."
        );
    }
});

/* ---------- Admin Upload ---------- */

bot.on(":video", async (ctx) => {
    try {
        if (String(ctx.from?.id) !== String(process.env.ADMIN_ID)) {
            await ctx.deleteMessage();
            await ctx.reply("❌ Only admin can upload videos.");
            return;
        }

        const video = ctx.message?.video;
        if (!video) return;

        const file_id = video.file_id;
        const title = ctx.message?.caption?.trim() || "Untitled Video";

        const thumbnail =
            video.thumbnail ??
            null;

        let thumbnail_url = "";

        if (thumbnail) {
            const buffer = await downloadTelegramFile(thumbnail.file_id);
            thumbnail_url = await uploadToGitHub(buffer, generateThumbnailPath());
        }

        const file = await File.create({
            file_id,
            title,
            thumbnail: thumbnail_url,
        });

        await ctx.reply(
            `✅ <b>Video uploaded successfully</b>\n\n` +
            `📌 <b>Title:</b> ${title}\n` +
            `🆔 <b>ID:</b> <code>${file._id}</code>\n` +
            `🖼️ <b>Thumbnail:</b> <a href="${thumbnail_url}">View</a>`,
            { parse_mode: "HTML" }
        );

    } catch (error) {
        console.error(error);
        await ctx.reply("🚫 Failed to save the video. Please try again.");
    }
});

/* ---------- Server ---------- */

app.get("/", (_, res) => {
    res.status(200).json({ message: "working" });
});

app.post(`/${process.env.BOT_TOKEN}`, webhookCallback(bot, "express"));


app.get("/api/files", async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page as string) || 1, 1);
        const limit = 30;
        const skip = (page - 1) * limit;

        const cacheKey = `files_page_${page}`;

        // Serve from cache if exists
        const cached = filesCache.get(cacheKey);
        if (cached) {
            return res.status(200).json(cached);
        }

        // DB query
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

        // Store in cache
        filesCache.set(cacheKey, response);

        res.status(200).json(response);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch files",
        });
    }
});


const PORT = process.env.PORT;

connectDB()
    .then(() => {
        app.listen(PORT, async () => {
            await bot.init();
            // run(bot);
            await bot.api.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/${process.env.BOT_TOKEN}`)
            console.log(`Server running on http://localhost:${PORT}`);
            new CronJob("*/12 * * * *", async () => { await fetch(process.env.RENDER_EXTERNAL_URL!); }, null, true)
        });

    })
    .catch(() => {
        process.exit(1);
    });
