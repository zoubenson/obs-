import type { RemoteClient, RemoteFile } from "./sync";

export class WebdavClient implements RemoteClient {
    private url: string;
    private headers: Record<string, string>;

    constructor(config: { url: string; username: string; password: string }) {
        this.url = config.url.replace(/\/$/, "");
        const token = btoa(`${config.username}:${config.password}`);
        this.headers = {
            Authorization: `Basic ${token}`,
        };
    }

    async connect() {
        console.log("[WebDAV] connect", this.url);
    }

    async disconnect() {}

    async listFiles(remoteDir: string): Promise<RemoteFile[]> {
        const dir = this.normalizePath(remoteDir);
        console.log(`[WebDAV] listFiles: ${dir}`);
        try {
            const items = await this.propfind(dir, 1);
            console.log(`[WebDAV] propfind returned`, items);
            if (!Array.isArray(items)) {
                console.warn("[WebDAV] items is not array, returning []");
                return [];
            }
            const result: RemoteFile[] = [];
            for (const item of items) {
                const absPath = item.path;
                if (absPath === dir) continue;
                if (!absPath.startsWith(dir + "/")) continue;
                let relative = absPath.slice(dir.length);
                relative = relative.replace(/^\/+/, "");
                // ✅ 关键修复：对路径进行解码
                relative = decodeURIComponent(relative);
                if (!relative) continue;
                result.push({
                    path: relative,
                    mtime: new Date(item.lastModified).getTime(),
                    isCollection: item.isCollection,
                });
            }
            console.log(`[WebDAV] listFiles result`, result);
            return result;
        } catch (err) {
            console.error(`[WebDAV] listFiles error for ${dir}:`, err);
            return [];
        }
    }

    // 其他方法保持不变 (download, upload, delete, mkdir)
    async download(remotePath: string, localPath: string) {
        const url = this.buildUrl(this.normalizePath(remotePath));
        const response = await fetch(url, { headers: this.headers });
        if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
        const arrayBuf = await response.arrayBuffer();
        const fs = require("fs").promises;
        await fs.mkdir(require("path").dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, Buffer.from(arrayBuf));
    }

    async upload(localPath: string, remotePath: string) {
        const content = await require("fs").promises.readFile(localPath);
        const url = this.buildUrl(this.normalizePath(remotePath));
        const res = await fetch(url, {
            method: "PUT",
            headers: this.headers,
            body: content,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
    }

    async delete(remotePath: string) {
        const url = this.buildUrl(this.normalizePath(remotePath));
        const res = await fetch(url, { method: "DELETE", headers: this.headers });
        if (!res.ok) throw new Error(`Delete failed: ${res.statusText}`);
    }

    async mkdir(remoteDir: string) {
        const parts = this.normalizePath(remoteDir).replace(/^\//, "").split("/");
        let currentPath = this.url;
        for (const part of parts) {
            currentPath += "/" + part;
            try {
                await fetch(currentPath, {
                    method: "MKCOL",
                    headers: this.headers,
                });
            } catch (err) {
                // 忽略已存在
            }
        }
    }

    private normalizePath(p: string): string {
        if (!p || p === "/") return "/";
        return "/" + p.replace(/^\/+/g, "").replace(/\/+$/g, "");
    }

    private buildUrl(remotePath: string): string {
        return this.url + remotePath;
    }

    private async propfind(dir: string, depth: 0 | 1): Promise<any[]> {
        const url = this.buildUrl(dir);
        const body = `<?xml version="1.0" encoding="utf-8"?>
            <propfind xmlns="DAV:">
              <prop>
                <getlastmodified xmlns="DAV:"/>
                <resourcetype xmlns="DAV:"/>
              </prop>
            </propfind>`;
        const res = await fetch(url, {
            method: "PROPFIND",
            headers: {
                ...this.headers,
                Depth: String(depth),
                "Content-Type": "application/xml",
            },
            body,
        });
        if (!res.ok) throw new Error(`PROPFIND not allowed (${res.status})`);
        const text = await res.text();
        return this.parsePropfind(text);
    }

    private parsePropfind(xml: string): any[] {
        const results: any[] = [];
        const regex = /<D:response>([\s\S]*?)<\/D:response>/g;
        let match;
        while ((match = regex.exec(xml)) !== null) {
            const block = match[1];
            const hrefMatch = /<D:href>([^<]+)<\/D:href>/.exec(block);
            const lastModMatch = /<D:getlastmodified>([^<]+)<\/D:getlastmodified>/.exec(block);
            const typeMatch = /<D:collection\/>/.test(block);
            if (!hrefMatch) continue;
            const href = hrefMatch[1];
            let path: string;
            if (href.startsWith("http://") || href.startsWith("https://")) {
                path = new URL(href).pathname;
            } else {
                path = href;
            }
            if (!path.startsWith("/")) path = "/" + path;
            results.push({
                path: path,
                lastModified: lastModMatch ? lastModMatch[1] : null,
                isCollection: typeMatch,
            });
        }
        return results;
    }
}
