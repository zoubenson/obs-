import SftpClientLib from "ssh2-sftp-client";
import type { RemoteClient, RemoteFile } from "./sync";

export class SftpClient implements RemoteClient {
    private client: SftpClientLib;
    private config: { host: string; port: number; username: string; password: string };

    constructor(config: { host: string; port: number; username: string; password: string }) {
        this.config = config;
        this.client = new SftpClientLib();
    }

    async connect() {
        await this.client.connect({
            host: this.config.host,
            port: this.config.port,
            username: this.config.username,
            password: this.config.password,
        });
    }

    async disconnect() {
        await this.client.end();
    }

    async listFiles(remoteDir: string): Promise<RemoteFile[]> {
        try {
            const dir = remoteDir || "/";
            const list = await this.client.list(dir);
            if (!Array.isArray(list)) {
                return [];
            }
            return list.map(item => ({
                path: item.name,
                mtime: item.modifyTime,
                isCollection: item.type === "d",
            }));
        } catch (err) {
            console.error(`[SFTP] listFiles error for ${remoteDir}:`, err);
            return [];
        }
    }

    async download(remotePath: string, localPath: string) {
        await this.client.fastGet(remotePath, localPath);
    }

    async upload(localPath: string, remotePath: string) {
        await this.client.fastPut(localPath, remotePath);
    }

    async delete(remotePath: string) {
        await this.client.delete(remotePath);
    }

    async mkdir(remoteDir: string) {
        try {
            await this.client.mkdir(remoteDir, true);
        } catch (err: any) {
            // 忽略目录已存在的错误
            if (!err.message?.includes("already exists")) {
                throw err;
            }
        }
    }
}
