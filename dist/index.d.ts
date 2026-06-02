import type { AstroIntegration } from "astro";
export interface IndexNowOptions {
    key?: string;
    siteUrl?: string;
    enabled?: boolean;
    cacheDir?: string;
    /** 百度资源平台推送配置 */
    baidu?: {
        token: string;
        site?: string;
        enabled?: boolean;
    };
}
export default function indexNow(options?: IndexNowOptions): AstroIntegration;
//# sourceMappingURL=index.d.ts.map