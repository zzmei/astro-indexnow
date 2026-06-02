import type { AstroIntegration } from "astro";
export interface IndexNowOptions {
    key?: string;
    siteUrl?: string;
    /** IndexNow 推送开关，默认 true */
    enabled?: boolean;
    cacheDir?: string;
    /** 百度资源平台推送配置 */
    baidu?: {
        token: string;
        site?: string;
        /** 百度推送开关，默认 true */
        enabled?: boolean;
        /** 每日推送配额上限，默认 10 */
        quota?: number;
    };
}
export default function indexNow(options?: IndexNowOptions): AstroIntegration;
//# sourceMappingURL=index.d.ts.map