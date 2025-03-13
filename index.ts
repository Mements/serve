import { build, type BuildConfig } from "bun";
import plugin from "bun-plugin-tailwind";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { readdir } from 'node:fs/promises';

export type ApiEndpoint = {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    body?: any;
    query?: Record<string, string | number | boolean>;
    response: any;
};

export type GetHealthEndpoint = {
    method: 'GET';
    path: '/api/health';
    query?: undefined;
    response: { status: string };
};

export type ApiEndpoints = Record<string, ApiEndpoint>;

type MeasureContext = {
    requestId?: string;
    level?: number;
    parentAction?: string;
};

export type MeasureFn = <T>(
    fn: (measure: MeasureFn) => Promise<T>,
    action: string,
    context?: MeasureContext
) => Promise<T>;

export async function measure<T>(
    fn: (measure: MeasureFn) => Promise<T>,
    action: string,
    context: MeasureContext = {}
): Promise<T> {
    const start = performance.now();
    const level = context.level || 0;
    const indent = "=".repeat(level);
    const requestId = context.requestId;
    const logPrefix = requestId ? `[${requestId}] ${indent}>` : indent;

    try {
        console.log(logPrefix, `Starting ${action}`);
        const result = await fn((nestedFn: (measure: MeasureFn) => Promise<any>, nestedAction: string) =>
            measure(nestedFn, nestedAction, {
                requestId: `${requestId}`,
                level: level + 1,
                parentAction: action
            })
        );
        const duration = performance.now() - start;
        console.log(logPrefix, `Completed ${action}`, `${duration.toFixed(2)}ms`);
        return result;
    } catch (error) {
        console.log(logPrefix, `Failed ${action}`, error);
        throw `${action} failed: ${error}`;
    }
}

type MiddlewareContext = {
    request: Request;
    method: string;
    path: string;
    query: Record<string, string>;
    body: any;
    headers: Headers;
};

interface PageConfig {
    route: string;
    target: string;
    handler: (ctx: MiddlewareContext & { requestId: string; measure: MeasureFn }) => Promise<any>;
}

interface ImportConfig {
    name: string;
    version?: string;
    deps?: string[];
}

export interface ServeOptions {
    pages: PageConfig[];
    api?: Record<string, (req: Request) => Promise<Response>>;
    imports: ImportConfig[];
}

type RouteMapping = Record<string, string>;
type ImportMap = { imports: Record<string, string> };

type EntrypointConfig = {
    path: string;
    serverData?: (ctx: MiddlewareContext & { requestId: string; measure: MeasureFn }) => Promise<any>;
};

const getHeaders = (ext: string) => {
    const contentTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
    };
    return {
        headers: {
            "Content-Type": contentTypes[ext] || "application/octet-stream",
        },
    };
};

async function servePage(
    response: Response,
    importMap: ImportMap,
    serverData = {},
    requestId: string
): Promise<Response> {
    return await measure(
        async (measure) => {
            const rewriter = new HTMLRewriter()
                .on("head", {
                    element(element) {
                        element.prepend(
                            `<script type="importmap">${JSON.stringify(importMap)}</script>`,
                            { html: true }
                        );
                    },
                })
                .on("body", {
                    element(element) {
                        const data = { ...serverData, requestId };
                        element.append(
                            `<script>window.serverData = ${JSON.stringify(data)}</script>`,
                            { html: true }
                        );
                    },
                });

            const transformedResponse = rewriter.transform(response);
            const transformedHtml = await transformedResponse.text();
            return new Response(transformedHtml, getHeaders(".html"));
        },
        "Transform page",
        { requestId, level: 2 }
    );
}

export async function serve(config: ServeOptions) {
    const isDev = process.env.NODE_ENV !== "production";
    const outdir = "./dist";

    const routeMap: RouteMapping = {};
    const entrypoints: Record<string, EntrypointConfig> = {};
    const pageHandlers: Record<string, (req: Request) => Promise<any>> = {};

    await measure(async (measure) => {
        for (const page of config.pages) {
            const relativePath = page.target.startsWith('./') ? page.target.substring(2) : page.target;
            routeMap[page.route] = relativePath;

            entrypoints[page.route] = { path: page.target, serverData: page.handler };

            pageHandlers[page.route] = async (req) => {
                const url = new URL(req.url);
                const query = Object.fromEntries(url.searchParams);
                const requestId = req.headers.get("X-Request-ID") || randomUUID().split('-')[0];
                const responseHeaders = new Headers();
                const ctx: MiddlewareContext & { requestId: string; measure: MeasureFn } = {
                    request: req,
                    method: req.method,
                    path: url.pathname,
                    query,
                    body: req.method !== 'GET' ? await req.json().catch(() => ({})) : undefined,
                    headers: req.headers,
                    requestId,
                    measure,
                };
                return await page.handler(ctx);
            };
        }
    }, "Initialize routes", { requestId: "init" });

    const importMap: ImportMap = { imports: {} };
    const versionMap: Record<string, string> = {};
    for (const imp of config.imports) {
        if (imp.name.startsWith('@')) {
            versionMap[imp.name] = imp.version ?? 'latest';
        } else {
            const baseName = imp.name.split('/')[0];
            versionMap[baseName] = imp.version ?? 'latest';
        }
    }

    for (const imp of config.imports) {
        let url: string;
        if (imp.name.startsWith('@')) {
            url = `https://esm.sh/${imp.name}@${versionMap[imp.name]}`;
        } else {
            const parts = imp.name.split('/');
            const baseName = parts[0];
            const subPaths = parts.slice(1);
            url = `https://esm.sh/${baseName}@${versionMap[baseName]}`;
            if (subPaths.length > 0) url += `/${subPaths.join('/')}`;
        }

        let queryParts: string[] = [];
        if (imp?.deps?.length) {
            const depsList = imp.deps
                .map(dep => `${dep}@${versionMap[dep.split('/')[0]]}`)
                .join(',');
            queryParts.push(`deps=${depsList}`);
        }
        if (isDev) queryParts.push('dev');
        if (queryParts.length) url += `?${queryParts.join('&')}`;

        importMap.imports[imp.name] = url;
    }

    console.log('===> Import map keys', Object.keys(importMap.imports));

    let serverPort = -1;
    const buildConfig: BuildConfig = {
        entrypoints: Object.values(entrypoints).map(e => e.path),
        outdir,
        plugins: [plugin],
        minify: !isDev,
        target: "browser",
        sourcemap: "linked",
        external: Object.keys(importMap.imports),
        define: {
            "process.env.NODE_ENV": JSON.stringify(isDev ? "development" : "production"),
            "process.env.HOST": isDev ? `http://localhost:${serverPort}` : "https://mements.ai",
        },
        naming: {
            chunk: "[name].[hash].[ext]",
            entry: "[dir]/[name].[hash].[ext]",
        },
    };

    if (existsSync(outdir)) {
        await rm(outdir, { recursive: true, force: true });
    }

    async function rebuildPage(pagePath: string, requestId: string): Promise<any> {
        if (isDev) {
            const baseName = path.basename(pagePath).split(".")[0].toLowerCase();
            const entrypoint = Object.values(entrypoints).find(e =>
                path.basename(e.path).split(".")[0].toLowerCase() === baseName
            );
            if (!entrypoint) return null;

            return await measure(
                async (measure) => {
                    try {
                        return await build({ ...buildConfig, entrypoints: [entrypoint.path] });
                    } catch (error) {
                        console.error("Failed to rebuild page:", error);
                        return null;
                    }
                },
                `Rebuild ${baseName}`,
                { requestId }
            );
        }
        return null;
    }

    const server = Bun.serve({
        development: isDev,
        async fetch(req) {
            const requestId = randomUUID().split('-')[0];
            const newHeaders = new Headers(req.headers);
            newHeaders.append("X-Request-ID", requestId);
            const reqWithId = new Request(req, { headers: newHeaders });

            return await measure(
                async (measure) => {
                    const url = new URL(reqWithId.url);
                    const pathname = url.pathname;

                    const distPath = path.join(process.cwd(), outdir, pathname);
                    if (await Bun.file(distPath).exists()) {
                        return new Response(Bun.file(distPath), getHeaders(path.extname(pathname)));
                    }

                    if (pageHandlers[pathname]) {
                        const routePath = routeMap[pathname];
                        return await measure(async (measure) => {
                            const dir = path.dirname(routePath);
                            const baseName = path.basename(routePath, path.extname(routePath));
                            const ext = path.extname(routePath);
                            const distDir = path.join(process.cwd(), outdir, dir);

                            let htmlFile = null;
                            let filePath = path.join(process.cwd(), outdir, routePath);

                            if (await Bun.file(filePath).exists()) {
                                htmlFile = Bun.file(filePath);
                            } else {
                                try {
                                    const files = await readdir(distDir);
                                    const matchingFile = files.find(file =>
                                        file.startsWith(baseName) && file.endsWith(ext)
                                    );
                                    if (matchingFile) {
                                        filePath = path.join(distDir, matchingFile);
                                        htmlFile = Bun.file(filePath);
                                    }
                                } catch (err) {
                                    console.error(`Error reading directory ${distDir}:`, err);
                                }
                            }

                            if (htmlFile) {
                                const pageBuildResult = await rebuildPage(filePath, requestId);
                                if (pageBuildResult) {
                                    const builtFile = pageBuildResult.outputs.find((it: { path: string }) => it.path.endsWith(ext));
                                    if (builtFile) htmlFile = Bun.file(builtFile.path);
                                }

                                let serverData = {};
                                const handler = pageHandlers[pathname];
                                if (handler) {
                                    serverData = await measure(
                                        async (measure) => handler(reqWithId),
                                        `serverData ${pathname}`
                                    );
                                }

                                return await servePage(
                                    new Response(htmlFile, getHeaders(ext)),
                                    importMap,
                                    serverData,
                                    requestId
                                );
                            }

                            throw `Page not found: ${routePath}`;
                        }, `page ${pathname}`);
                    }

                    if (config.api && pathname in config.api) {
                        return await measure(
                            async (measure) => config.api![pathname](reqWithId),
                            `endpoint ${pathname}`
                        );
                    }

                    return new Response("Route Not Found", { status: 404 });
                },
                `${req.method} ${req.url}`,
                { requestId }
            );
        },
        error(error) {
            console.error("Server Error:", error);
            return new Response(
                `<pre>${error}\n${error.stack}</pre>`,
                { headers: { "Content-Type": "text/html" }, status: 500 }
            );
        },
    });

    serverPort = server.port;
    await measure(() => build(buildConfig), "Initial build");

    console.log(`🚀 Server running at http://localhost:${server.port}`);
    return server;
}

if (require.main === module) {
    const exampleConfig: ServeOptions = {
        pages: [
            {
                route: '/',
                target: './pages/index.tsx',
                handler: async (ctx) => ({ message: `Hello from ${ctx.path}` }),
            },
        ],
        api: {
            '/api/health': async (req) => new Response(JSON.stringify({ status: 'ok' }), {
                headers: { "Content-Type": "application/json" },
            }),
        },
        imports: [
            { name: 'react', version: '18.2.0' },
            { name: 'react-dom/client', version: '18.2.0' },
        ],
    };

    serve(exampleConfig);
}