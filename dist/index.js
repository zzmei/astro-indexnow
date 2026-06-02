import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
const BAIDU_ENDPOINT = "http://data.zz.baidu.com/urls"; // 百度官方接口仅支持 http
async function pushToBaidu({ urls, token, site, logger, }) {
    const baiduUrl = `${BAIDU_ENDPOINT}?site=${encodeURIComponent(site)}&token=${encodeURIComponent(token)}`;
    const bodyText = urls.join("\n");
    logger.info(`[astro-indexnow] pushing ${urls.length} URLs to Baidu`);
    try {
        const response = await fetch(baiduUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: bodyText,
        });
        if (response.ok) {
            const result = await response.json();
            // 典型返回：{"remain": 剩余配额, "success": 成功推送数量}
            logger.info(`[astro-indexnow] Baidu push result: ${JSON.stringify(result)}`);
        }
        else {
            logger.warn(`[astro-indexnow] Baidu push failed (HTTP ${response.status})`);
        }
    }
    catch (err) {
        logger.warn(`[astro-indexnow] Baidu push network error: ${err.message}`);
    }
}
/* =========================================================
   主集成入口
   ========================================================= */
export default function indexNow(options = {}) {
    let site = null;
    let baiduToken = null;
    let baiduSite = null;
    let baiduEnabled = true;
    const CACHE_FILENAME = ".astro-indexnow-cache.json";
    const projectRoot = process.cwd();
    const cachePath = options.cacheDir
        ? path.resolve(projectRoot, options.cacheDir, CACHE_FILENAME)
        : path.join(projectRoot, CACHE_FILENAME);
    const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
    const INDEXNOW_BATCH_SIZE = 2_000;
    /* =========================================================
       Helpers
       ========================================================= */
    function ensureCacheFile(logger) {
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
            logger.debug(`[astro-indexnow] creating cache directory: ${dir}`);
            fs.mkdirSync(dir, { recursive: true });
        }
        const exists = fs.existsSync(cachePath);
        logger.debug(`[astro-indexnow] cache exists: ${exists} (${cachePath})`);
        if (!exists) {
            logger.debug("[astro-indexnow] creating cache file");
            fs.writeFileSync(cachePath, "{}", "utf8");
        }
    }
    function hashFile(filePath) {
        const contents = fs.readFileSync(filePath);
        const hash = crypto.createHash("sha256");
        hash.update(contents);
        return `sha256:${hash.digest("hex")}`;
    }
    function loadCache(logger) {
        logger.debug("[astro-indexnow] loading cache file");
        try {
            return JSON.parse(fs.readFileSync(cachePath, "utf8"));
        }
        catch {
            logger.warn("[astro-indexnow] cache file unreadable, resetting");
            return {};
        }
    }
    function saveCache(logger, data) {
        logger.debug("[astro-indexnow] writing cache file");
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
    }
    function chunk(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
    /* =========================================================
       Integration
       ========================================================= */
    return {
        name: "astro-indexnow",
        hooks: {
            /* -----------------------------------------------
               Setup
               ----------------------------------------------- */
            "astro:config:setup": ({ config, logger }) => {
                site =
                    options.siteUrl ??
                        (config.site ? config.site.replace(/\/$/, "") : null);
                // 提取百度推送配置
                if (options.baidu) {
                    baiduToken = options.baidu.token || null;
                    baiduSite = options.baidu.site ?? site;
                    baiduEnabled = options.baidu.enabled !== false;
                    if (!baiduToken) {
                        logger.warn("[astro-indexnow] Baidu token is empty, push disabled");
                    }
                }
                logger.debug(`[astro-indexnow] project root: ${projectRoot}`);
                ensureCacheFile(logger);
            },
            /* -----------------------------------------------
               Build done
               ----------------------------------------------- */
            "astro:build:done": async ({ dir, logger }) => {
                // IndexNow 开关检查
                if (options.enabled === false) {
                    logger.info("[astro-indexnow] disabled");
                    return;
                }
                if (!options.key) {
                    throw new Error("[astro-indexnow] Missing IndexNow key");
                }
                if (!site) {
                    throw new Error("[astro-indexnow] Missing site URL");
                }
                ensureCacheFile(logger);
                // dir 在 Astro 中始终为 URL 类型
                const outDir = fileURLToPath(dir);
                const previousCache = loadCache(logger);
                const nextCache = {};
                const changedUrls = [];
                // 递归遍历构建产物，收集变更的 index.html 页面
                function walk(currentDir) {
                    for (const entry of fs.readdirSync(currentDir, {
                        withFileTypes: true,
                    })) {
                        const fullPath = path.join(currentDir, entry.name);
                        if (entry.isDirectory()) {
                            walk(fullPath);
                            continue;
                        }
                        if (entry.isFile() && entry.name === "index.html") {
                            const relativePath = path
                                .relative(outDir, fullPath)
                                .replace(/index\.html$/, "")
                                .replace(/\\/g, "/");
                            const url = site + "/" + relativePath.replace(/^\/+/, "");
                            const hash = hashFile(fullPath);
                            nextCache[url] = hash;
                            if (previousCache[url] !== hash) {
                                changedUrls.push(url);
                            }
                        }
                    }
                }
                walk(outDir);
                // 输出每个页面的变更状态
                logger.debug("[astro-indexnow] page diff:");
                for (const url of Object.keys(nextCache)) {
                    const state = previousCache[url] === nextCache[url]
                        ? "unchanged"
                        : "new/changed";
                    logger.debug(` - ${url} (${state})`);
                }
                // 无变更则跳过所有提交
                if (changedUrls.length === 0) {
                    logger.info("[astro-indexnow] no changed URLs detected, skipping submission");
                    saveCache(logger, nextCache);
                    return;
                }
                /* -----------------------------------------------
                   IndexNow 批量提交
                   ----------------------------------------------- */
                const batches = chunk(changedUrls, INDEXNOW_BATCH_SIZE);
                logger.info(`[astro-indexnow] submitting ${changedUrls.length} changed URLs in ${batches.length} batch(es)`);
                let anyBatchFailed = false;
                for (let i = 0; i < batches.length; i++) {
                    const batch = batches[i];
                    logger.debug(`[astro-indexnow] submitting batch ${i + 1}/${batches.length} (${batch.length} URLs)`);
                    try {
                        const response = await fetch(INDEXNOW_ENDPOINT, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                host: new URL(site).host,
                                key: options.key,
                                keyLocation: `${site}/${options.key}.txt`,
                                urlList: batch,
                            }),
                        });
                        if (!response.ok) {
                            anyBatchFailed = true;
                            logger.warn(`[astro-indexnow] batch ${i + 1}/${batches.length} failed (HTTP ${response.status})`);
                        }
                        else {
                            logger.debug(`[astro-indexnow] batch ${i + 1}/${batches.length} submitted successfully`);
                        }
                    }
                    catch (err) {
                        anyBatchFailed = true;
                        logger.warn(`[astro-indexnow] batch ${i + 1}/${batches.length} network error: ${err.message}`);
                    }
                }
                // 仅在全部批次成功时更新缓存，保证失败的 URL 下次构建可重试
                if (!anyBatchFailed) {
                    saveCache(logger, nextCache);
                    logger.info("[astro-indexnow] IndexNow submission complete");
                }
                else {
                    logger.warn("[astro-indexnow] some batches failed, cache not updated — will retry on next build");
                }
                /* -----------------------------------------------
                   百度资源平台推送
                   ----------------------------------------------- */
                if (baiduEnabled && baiduToken) {
                    if (!baiduSite) {
                        logger.warn("[astro-indexnow] Baidu site URL missing, skipping push");
                    }
                    else {
                        await pushToBaidu({
                            urls: changedUrls,
                            token: baiduToken,
                            site: baiduSite,
                            logger,
                        });
                    }
                }
            },
        },
    };
}
