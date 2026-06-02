import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import { fileURLToPath } from "url";
/* =========================================================
   IndexNow 批量提交（独立封装）
   返回 true 表示全部批次成功
   ========================================================= */
async function pushToIndexNow({ batches, site, key, endpoint, logger, }) {
    let anyBatchFailed = false;
    const total = batches.reduce((s, b) => s + b.length, 0);
    logger.info(`[astro-indexnow] IndexNow submitting ${total} URLs in ${batches.length} batch(es)`);
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.debug(`[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} (${batch.length} URLs)`);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    host: new URL(site).host,
                    key,
                    keyLocation: `${site}/${key}.txt`,
                    urlList: batch,
                }),
            });
            if (!response.ok) {
                anyBatchFailed = true;
                logger.warn(`[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} failed (HTTP ${response.status})`);
            }
            else {
                logger.debug(`[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} submitted successfully`);
            }
        }
        catch (err) {
            anyBatchFailed = true;
            logger.warn(`[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} network error: ${err.message}`);
        }
    }
    return !anyBatchFailed;
}
/* =========================================================
   百度底层 HTTP 请求（独立封装）
   发送请求并返回解析后的响应，网络/解析异常返回 null
   ========================================================= */
function baiduRequest({ body, token, site, logger, }) {
    const reqPath = `/urls?site=${site}&token=${token}`;
    return new Promise((resolve) => {
        const req = http.request({
            hostname: "data.zz.baidu.com",
            port: 80,
            method: "POST",
            path: reqPath,
            headers: {
                "Content-Type": "text/plain",
                "Content-Length": Buffer.byteLength(body),
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const result = JSON.parse(data);
                    if (res.statusCode === 200) {
                        resolve(result);
                    }
                    else if (result?.message === "over quota") {
                        // 配额耗尽，视为 remain=0 的正常响应
                        logger.warn("[astro-indexnow] Baidu daily quota exhausted (over quota), quota resets at midnight");
                        resolve({ remain: 0, success: 0 });
                    }
                    else {
                        logger.warn(`[astro-indexnow] Baidu request failed (HTTP ${res.statusCode}): ${data}`);
                        resolve(null);
                    }
                }
                catch {
                    logger.warn(`[astro-indexnow] Baidu invalid JSON response: ${data}`);
                    resolve(null);
                }
            });
        });
        req.on("error", (err) => {
            logger.error(`[astro-indexnow] Baidu network error: ${err.message}`);
            resolve(null);
        });
        req.write(body);
        req.end();
    });
}
/* =========================================================
   查询百度剩余配额
   通过推送特殊 URL "*" 查询，不占用有效提交额度
   ========================================================= */
async function queryBaiduRemain(token, site, logger) {
    logger.debug("[astro-indexnow] Baidu querying remain quota via '*'");
    const result = await baiduRequest({
        body: "*",
        token,
        site,
        logger,
    });
    if (result === null) {
        // 网络或解析异常，返回 -1 表示未知
        return -1;
    }
    logger.info(`[astro-indexnow] Baidu remain quota: ${result.remain}`);
    return result.remain;
}
/* =========================================================
   百度资源平台推送（独立封装）
   返回实际成功推送数量，-1 表示网络/解析异常
   ========================================================= */
async function pushToBaidu({ urls, token, site, logger, }) {
    logger.info(`[astro-indexnow] Baidu pushing ${urls.length} URLs`);
    const result = await baiduRequest({
        body: urls.join("\n"),
        token,
        site,
        logger,
    });
    if (result === null) {
        return -1;
    }
    logger.info(`[astro-indexnow] Baidu push success: success=${result.success}, remain=${result.remain}`);
    if (result.remain === 0) {
        logger.warn("[astro-indexnow] Baidu daily quota exhausted after this push, quota resets at midnight");
    }
    return result.success ?? 0;
}
/* =========================================================
   主集成入口
   ========================================================= */
export default function indexNow(options = {}) {
    let site = null;
    // 百度配置
    let baiduToken = null;
    let baiduSite = null;
    let baiduEnabled = false;
    const projectRoot = process.cwd();
    const cacheBase = options.cacheDir
        ? path.resolve(projectRoot, options.cacheDir)
        : projectRoot;
    // 两个独立缓存文件
    const INDEXNOW_CACHE_FILE = path.join(cacheBase, ".astro-indexnow-cache.json");
    const BAIDU_CACHE_FILE = path.join(cacheBase, ".astro-baidu-cache.json");
    const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
    const INDEXNOW_BATCH_SIZE = 2_000;
    // IndexNow 开关
    const indexNowEnabled = options.enabled !== false;
    /* =========================================================
       通用 Helpers
       ========================================================= */
    function ensureFile(filePath, defaultContent, logger) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            logger.debug(`[astro-indexnow] creating directory: ${dir}`);
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(filePath)) {
            logger.debug(`[astro-indexnow] creating file: ${filePath}`);
            fs.writeFileSync(filePath, defaultContent, "utf8");
        }
    }
    function hashFile(filePath) {
        const contents = fs.readFileSync(filePath);
        const hash = crypto.createHash("sha256");
        hash.update(contents);
        return `sha256:${hash.digest("hex")}`;
    }
    function chunk(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
    /* =========================================================
       IndexNow 缓存 Helpers
       ========================================================= */
    function ensureIndexNowCache(logger) {
        ensureFile(INDEXNOW_CACHE_FILE, "{}", logger);
    }
    function loadIndexNowCache(logger) {
        logger.debug("[astro-indexnow] loading IndexNow cache");
        try {
            return JSON.parse(fs.readFileSync(INDEXNOW_CACHE_FILE, "utf8"));
        }
        catch {
            logger.warn("[astro-indexnow] IndexNow cache unreadable, resetting");
            return {};
        }
    }
    function saveIndexNowCache(logger, data) {
        logger.debug("[astro-indexnow] saving IndexNow cache");
        fs.writeFileSync(INDEXNOW_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
    }
    /* =========================================================
       百度缓存 Helpers
       ========================================================= */
    const BAIDU_CACHE_DEFAULT = JSON.stringify({ pushed: {}, pending: {} }, null, 2);
    function ensureBaiduCache(logger) {
        ensureFile(BAIDU_CACHE_FILE, BAIDU_CACHE_DEFAULT, logger);
    }
    function loadBaiduCache(logger) {
        logger.debug("[astro-indexnow] loading Baidu cache");
        try {
            const raw = JSON.parse(fs.readFileSync(BAIDU_CACHE_FILE, "utf8"));
            return {
                pushed: raw.pushed ?? {},
                pending: raw.pending ?? {},
            };
        }
        catch {
            logger.warn("[astro-indexnow] Baidu cache unreadable, resetting");
            return { pushed: {}, pending: {} };
        }
    }
    function saveBaiduCache(logger, data) {
        logger.debug("[astro-indexnow] saving Baidu cache");
        fs.writeFileSync(BAIDU_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
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
                if (options.baidu) {
                    baiduToken = options.baidu.token || null;
                    baiduSite = options.baidu.site ?? site;
                    baiduEnabled = options.baidu.enabled !== false;
                    if (!baiduToken) {
                        logger.warn("[astro-indexnow] Baidu token is empty, push disabled");
                        baiduEnabled = false;
                    }
                }
                logger.debug(`[astro-indexnow] project root: ${projectRoot}`);
                logger.debug(`[astro-indexnow] IndexNow enabled: ${indexNowEnabled}, Baidu enabled: ${baiduEnabled}`);
                if (indexNowEnabled)
                    ensureIndexNowCache(logger);
                if (baiduEnabled)
                    ensureBaiduCache(logger);
            },
            /* -----------------------------------------------
               Build done
               ----------------------------------------------- */
            "astro:build:done": async ({ dir, logger }) => {
                // 两个开关都关闭时直接跳过
                if (!indexNowEnabled && !baiduEnabled) {
                    logger.info("[astro-indexnow] both IndexNow and Baidu are disabled, skipping");
                    return;
                }
                if (indexNowEnabled && !options.key) {
                    throw new Error("[astro-indexnow] Missing IndexNow key");
                }
                if (!site) {
                    throw new Error("[astro-indexnow] Missing site URL");
                }
                if (indexNowEnabled)
                    ensureIndexNowCache(logger);
                if (baiduEnabled)
                    ensureBaiduCache(logger);
                const outDir = fileURLToPath(dir);
                /* -----------------------------------------------
                   扫描构建产物，生成当前全量页面哈希表
                   ----------------------------------------------- */
                const scannedPages = {};
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
                            scannedPages[url] = hashFile(fullPath);
                        }
                    }
                }
                walk(outDir);
                /* -----------------------------------------------
                   IndexNow 逻辑
                   ----------------------------------------------- */
                if (indexNowEnabled) {
                    const prevCache = loadIndexNowCache(logger);
                    const changedUrls = Object.keys(scannedPages).filter((url) => prevCache[url] !== scannedPages[url]);
                    logger.debug("[astro-indexnow] IndexNow page diff:");
                    for (const url of Object.keys(scannedPages)) {
                        const state = prevCache[url] === scannedPages[url] ? "unchanged" : "new/changed";
                        logger.debug(` - ${url} (${state})`);
                    }
                    if (changedUrls.length === 0) {
                        logger.info("[astro-indexnow] IndexNow: no changed URLs, skipping");
                    }
                    else {
                        const batches = chunk(changedUrls, INDEXNOW_BATCH_SIZE);
                        const allSuccess = await pushToIndexNow({
                            batches,
                            site,
                            key: options.key,
                            endpoint: INDEXNOW_ENDPOINT,
                            logger,
                        });
                        if (allSuccess) {
                            // 全部成功：以本次扫描结果覆盖缓存
                            saveIndexNowCache(logger, scannedPages);
                            logger.info("[astro-indexnow] IndexNow submission complete, cache updated");
                        }
                        else {
                            logger.warn("[astro-indexnow] IndexNow: some batches failed, cache NOT updated — will retry on next build");
                        }
                    }
                }
                /* -----------------------------------------------
                   百度推送逻辑
                   ----------------------------------------------- */
                if (baiduEnabled) {
                    if (!baiduSite) {
                        logger.warn("[astro-indexnow] Baidu site URL missing, skipping push");
                    }
                    else {
                        const baiduCache = loadBaiduCache(logger);
                        // 1. 将本次扫描到的新增/变更页面合并进 pending
                        for (const [url, hash] of Object.entries(scannedPages)) {
                            const alreadyPushed = baiduCache.pushed[url] === hash;
                            if (!alreadyPushed) {
                                baiduCache.pending[url] = hash;
                                delete baiduCache.pushed[url];
                            }
                        }
                        const pendingUrls = Object.keys(baiduCache.pending);
                        if (pendingUrls.length === 0) {
                            logger.info("[astro-indexnow] Baidu: no pending URLs, skipping push");
                            saveBaiduCache(logger, baiduCache);
                        }
                        else {
                            // 2. 查询今日剩余配额（推送 "*" 不占额度）
                            const remain = await queryBaiduRemain(baiduToken, baiduSite, logger);
                            if (remain === -1) {
                                // 网络异常，不变更缓存，下次重试
                                logger.warn("[astro-indexnow] Baidu: failed to query quota, cache NOT updated — will retry on next build");
                            }
                            else if (remain === 0) {
                                // 配额已耗尽，保存合并后的 pending，等待明日重试
                                logger.warn(`[astro-indexnow] Baidu: remain=0, quota exhausted. ${pendingUrls.length} URLs stay in pending — will retry on next build`);
                                saveBaiduCache(logger, baiduCache);
                            }
                            else {
                                // 3. 按配额截取待推送列表
                                const toSubmit = pendingUrls.slice(0, remain);
                                const deferred = pendingUrls.slice(remain);
                                logger.info(`[astro-indexnow] Baidu: pending=${pendingUrls.length}, remain=${remain}, submitting=${toSubmit.length}, deferred=${deferred.length}`);
                                // 4. 执行推送
                                const successCount = await pushToBaidu({
                                    urls: toSubmit,
                                    token: baiduToken,
                                    site: baiduSite,
                                    logger,
                                });
                                if (successCount === -1) {
                                    // 网络/解析异常，不变更缓存
                                    logger.warn("[astro-indexnow] Baidu: push failed, cache NOT updated — will retry on next build");
                                }
                                else if (successCount === 0) {
                                    // 服务端全部拒绝，不变更缓存
                                    logger.warn("[astro-indexnow] Baidu: 0 URLs accepted, cache NOT updated — will retry on next build");
                                }
                                else {
                                    // 5. 成功推送的移入 pushed，从 pending 删除
                                    const successUrls = toSubmit.slice(0, successCount);
                                    for (const url of successUrls) {
                                        baiduCache.pushed[url] = baiduCache.pending[url];
                                        delete baiduCache.pending[url];
                                    }
                                    logger.info(`[astro-indexnow] Baidu cache updated: pushed=${Object.keys(baiduCache.pushed).length}, pending=${Object.keys(baiduCache.pending).length}`);
                                    saveBaiduCache(logger, baiduCache);
                                }
                            }
                        }
                    }
                }
            },
        },
    };
}
