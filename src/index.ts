import type { AstroIntegration } from "astro";
import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import { fileURLToPath } from "url";

export interface IndexNowOptions {
  key?: string;
  siteUrl?: string;
  /** IndexNow 提交开关，默认 true */
  enabled?: boolean;
  cacheDir?: string;
  /** 百度资源平台推送配置 */
  baidu?: {
    token: string;
    site?: string;
    /** 百度推送开关，默认 true */
    enabled?: boolean;
  };
}

/* =========================================================
   类型定义
   ========================================================= */

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
}

interface BaiduPushParams {
  urls: string[];
  token: string;
  site: string;
  logger: Logger;
}

interface IndexNowPushParams {
  batches: string[][];
  site: string;
  key: string;
  endpoint: string;
  logger: Logger;
}

/* =========================================================
   百度资源平台推送（独立封装）
   ========================================================= */

async function pushToBaidu({
  urls,
  token,
  site,
  logger,
}: BaiduPushParams): Promise<void> {
  const bodyText = urls.join("\n");
  const reqPath = `/urls?site=${site}&token=${token}`;

  logger.info(`[astro-indexnow] Baidu pushing ${urls.length} URLs`);

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "data.zz.baidu.com",
        port: 80,
        method: "POST",
        path: reqPath,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(bodyText),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode === 200) {
              logger.info(
                `[astro-indexnow] Baidu push success: remain=${result.remain}, success=${result.success}`
              );
            } else {
              logger.warn(
                `[astro-indexnow] Baidu push failed (HTTP ${res.statusCode}): ${data}`
              );
            }
          } catch {
            logger.warn(
              `[astro-indexnow] Baidu invalid JSON response: ${data}`
            );
          }
          resolve();
        });
      }
    );

    req.on("error", (err) => {
      logger.error(`[astro-indexnow] Baidu network error: ${err.message}`);
      resolve(); // 网络错误不中断主流程
    });

    req.write(bodyText);
    req.end();
  });
}

/* =========================================================
   IndexNow 批量提交（独立封装）
   ========================================================= */

async function pushToIndexNow({
  batches,
  site,
  key,
  endpoint,
  logger,
}: IndexNowPushParams): Promise<boolean> {
  let anyBatchFailed = false;

  logger.info(
    `[astro-indexnow] IndexNow submitting ${batches.flat().length} URLs in ${batches.length} batch(es)`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    logger.debug(
      `[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} (${batch.length} URLs)`
    );

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
        logger.warn(
          `[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} failed (HTTP ${response.status})`
        );
      } else {
        logger.debug(
          `[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} submitted successfully`
        );
      }
    } catch (err) {
      anyBatchFailed = true;
      logger.warn(
        `[astro-indexnow] IndexNow batch ${i + 1}/${batches.length} network error: ${(err as Error).message}`
      );
    }
  }

  return !anyBatchFailed; // true = 全部成功
}

/* =========================================================
   主集成入口
   ========================================================= */

export default function indexNow(
  options: IndexNowOptions = {}
): AstroIntegration {
  let site: string | null = null;
  let baiduToken: string | null = null;
  let baiduSite: string | null = null;
  let baiduEnabled = false;

  const CACHE_FILENAME = ".astro-indexnow-cache.json";
  const projectRoot = process.cwd();
  const cachePath = options.cacheDir
    ? path.resolve(projectRoot, options.cacheDir, CACHE_FILENAME)
    : path.join(projectRoot, CACHE_FILENAME);

  const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
  const INDEXNOW_BATCH_SIZE = 2_000;

  // IndexNow 开关：未配置时默认 true
  const indexNowEnabled = options.enabled !== false;

  /* =========================================================
     Helpers
     ========================================================= */

  function ensureCacheFile(logger: Logger) {
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

  function hashFile(filePath: string): string {
    const contents = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256");
    hash.update(contents);
    return `sha256:${hash.digest("hex")}`;
  }

  function loadCache(logger: Logger): Record<string, string> {
    logger.debug("[astro-indexnow] loading cache file");
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      logger.warn("[astro-indexnow] cache file unreadable, resetting");
      return {};
    }
  }

  function saveCache(logger: Logger, data: Record<string, string>) {
    logger.debug("[astro-indexnow] writing cache file");
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
  }

  function chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
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
            logger.warn(
              "[astro-indexnow] Baidu token is empty, push disabled"
            );
            baiduEnabled = false;
          }
        }

        logger.debug(`[astro-indexnow] project root: ${projectRoot}`);
        logger.debug(
          `[astro-indexnow] IndexNow enabled: ${indexNowEnabled}, Baidu enabled: ${baiduEnabled}`
        );

        ensureCacheFile(logger);
      },

      /* -----------------------------------------------
         Build done
         ----------------------------------------------- */
      "astro:build:done": async ({ dir, logger }) => {
        // 两个开关都关闭时直接跳过
        if (!indexNowEnabled && !baiduEnabled) {
          logger.info(
            "[astro-indexnow] both IndexNow and Baidu are disabled, skipping"
          );
          return;
        }

        // IndexNow 启用时才校验 key
        if (indexNowEnabled && !options.key) {
          throw new Error("[astro-indexnow] Missing IndexNow key");
        }

        if (!site) {
          throw new Error("[astro-indexnow] Missing site URL");
        }

        ensureCacheFile(logger);

        // dir 在 Astro 中始终为 URL 类型
        const outDir = fileURLToPath(dir);

        const previousCache = loadCache(logger);
        const nextCache: Record<string, string> = {};
        const changedUrls: string[] = [];

        // 递归遍历构建产物，收集变更的 index.html 页面
        function walk(currentDir: string) {
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
          const state =
            previousCache[url] === nextCache[url]
              ? "unchanged"
              : "new/changed";
          logger.debug(` - ${url} (${state})`);
        }

        // 无变更则跳过所有提交
        if (changedUrls.length === 0) {
          logger.info(
            "[astro-indexnow] no changed URLs detected, skipping submission"
          );
          saveCache(logger, nextCache);
          return;
        }

        /* -----------------------------------------------
           IndexNow 批量提交
           ----------------------------------------------- */
        if (indexNowEnabled) {
          const batches = chunk(changedUrls, INDEXNOW_BATCH_SIZE);
          const allSuccess = await pushToIndexNow({
            batches,
            site,
            key: options.key!,
            endpoint: INDEXNOW_ENDPOINT,
            logger,
          });

          if (allSuccess) {
            saveCache(logger, nextCache);
            logger.info("[astro-indexnow] IndexNow submission complete");
          } else {
            logger.warn(
              "[astro-indexnow] some IndexNow batches failed, cache not updated — will retry on next build"
            );
          }
        } else {
          logger.info("[astro-indexnow] IndexNow disabled, skipping");
          // IndexNow 关闭时直接保存缓存，避免下次重复推送百度
          saveCache(logger, nextCache);
        }

        /* -----------------------------------------------
           百度资源平台推送
           ----------------------------------------------- */
        if (baiduEnabled) {
          if (!baiduSite) {
            logger.warn(
              "[astro-indexnow] Baidu site URL missing, skipping push"
            );
          } else {
            await pushToBaidu({
              urls: changedUrls,
              token: baiduToken!,
              site: baiduSite,
              logger,
            });
          }
        } else {
          logger.info("[astro-indexnow] Baidu push disabled, skipping");
        }
      },
    },
  };
}
