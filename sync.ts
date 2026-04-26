import { Notice, normalizePath } from "obsidian";
import * as path from "path";
import type BidirectionalSyncPlugin from "./main";
import { SftpClient } from "./sftp-client";
import { WebdavClient } from "./webdav-client";

export interface RemoteClient {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    listFiles(remoteDir: string): Promise<RemoteFile[]>;
    download(remotePath: string, localPath: string): Promise<void>;
    upload(localPath: string, remotePath: string): Promise<void>;
    delete(remotePath: string): Promise<void>;
    mkdir(remoteDir: string): Promise<void>;
}

export interface RemoteFile {
    path: string;
    mtime: number;
    isCollection?: boolean;
}

export interface SyncState {
    [vaultPath: string]: {
        localMtime: number;
        remoteMtime: number;
    }
}

export class SyncManager {
    plugin: BidirectionalSyncPlugin;
    client: RemoteClient | null = null;
    statePath: string;
    private syncing = false;   // 防止并发

    constructor(plugin: BidirectionalSyncPlugin) {
        this.plugin = plugin;
        this.statePath = normalizePath(".sync-state.json");
    }

    async fullSync() {
        if (this.syncing) {
            new Notice("Sync already in progress, please wait...");
            return;
        }
        this.syncing = true;
        new Notice("Sync started");
        try {
            await this.initClient();
            await this.client!.connect();
            const state = await this.loadState();
            const settings = this.plugin.settings;
            const remoteRoot = settings.remoteRoot.replace(/\/$/, "") || "/";

            const localFiles = this.getLocalFiles();
            const remoteFiles = await this.client!.listFiles(remoteRoot);

            const localMap = new Map(localFiles.map(f => [f.path, f]));
            const remoteMap = new Map(remoteFiles.map(f => [f.path, f]));

            const allPaths = new Set([
                ...localMap.keys(),
                ...remoteMap.keys(),
                ...Object.keys(state),
            ]);

            for (const relPath of allPaths) {
                try {
                    await this.processPath(relPath, localMap, remoteMap, state, remoteRoot);
                } catch (err) {
                    console.error(`Error processing ${relPath}:`, err);
                    // 继续处理下一个文件
                }
            }

            await this.saveState(state);
            new Notice("Sync completed");
        } catch (err) {
            console.error("Sync failed:", err);
            new Notice("Sync failed: " + err.message);
        } finally {
            await this.client?.disconnect();
            this.syncing = false;
        }
    }

    private async processPath(
        relPath: string,
        localMap: Map<string, { path: string; mtime: number }>,
        remoteMap: Map<string, RemoteFile>,
        state: SyncState,
        remoteRoot: string
    ) {
        const localFile = localMap.get(relPath);
        const remoteFile = remoteMap.get(relPath);
        const stateEntry = state[relPath];

        const localMtime = localFile?.mtime ?? 0;
        const remoteMtime = remoteFile?.mtime ?? 0;
        const prevLocalMtime = stateEntry?.localMtime ?? 0;
        const prevRemoteMtime = stateEntry?.remoteMtime ?? 0;

        // 两者都不存在 -> 删除记录
        if (!localFile && !remoteFile) {
            delete state[relPath];
            return;
        }

        // 仅本地存在
        if (localFile && !remoteFile) {
            if (stateEntry && prevRemoteMtime !== 0) {
                if (localMtime === prevLocalMtime) {
                    await this.deleteLocal(relPath);
                    delete state[relPath];
                } else {
                    await this.uploadLocal(relPath, remoteRoot);
                    state[relPath] = {
                        localMtime,
                        remoteMtime: await this.getRemoteMtime(relPath, remoteRoot)
                    };
                }
            } else {
                await this.uploadLocal(relPath, remoteRoot);
                state[relPath] = {
                    localMtime,
                    remoteMtime: await this.getRemoteMtime(relPath, remoteRoot)
                };
            }
            return;
        }

        // 仅远程存在
        if (!localFile && remoteFile) {
            if (stateEntry && prevLocalMtime !== 0) {
                if (remoteMtime === prevRemoteMtime) {
                    await this.deleteRemote(relPath, remoteRoot);
                    delete state[relPath];
                } else {
                    await this.downloadRemote(relPath, remoteRoot);
                    state[relPath] = { localMtime: Date.now(), remoteMtime };
                }
            } else {
                await this.downloadRemote(relPath, remoteRoot);
                state[relPath] = { localMtime: Date.now(), remoteMtime };
            }
            return;
        }

        // 两者都存在
        if (localFile && remoteFile) {
            const localChanged = localMtime !== prevLocalMtime;
            const remoteChanged = remoteMtime !== prevRemoteMtime;

            if (!localChanged && !remoteChanged) {
                state[relPath] = { localMtime, remoteMtime };
                return;
            }

            if (localChanged && remoteChanged) {
                // 冲突处理
                switch (this.plugin.settings.conflictPolicy) {
                    case "newest":
                        if (localMtime > remoteMtime) {
                            await this.uploadLocal(relPath, remoteRoot);
                        } else {
                            await this.downloadRemote(relPath, remoteRoot);
                        }
                        break;
                    case "local":
                        await this.uploadLocal(relPath, remoteRoot);
                        break;
                    case "remote":
                        await this.downloadRemote(relPath, remoteRoot);
                        break;
                    case "ask":
                        new Notice(`Conflict on ${relPath}, skipped.`);
                        return;
                }
                const newRemoteMtime = await this.getRemoteMtime(relPath, remoteRoot);
                const newLocalMtime = (await this.plugin.app.vault.adapter.stat(relPath))?.mtime ?? Date.now();
                state[relPath] = { localMtime: newLocalMtime, remoteMtime: newRemoteMtime };
                return;
            }

            // 仅一方变更
            if (localChanged && !remoteChanged) {
                await this.uploadLocal(relPath, remoteRoot);
                state[relPath] = {
                    localMtime,
                    remoteMtime: await this.getRemoteMtime(relPath, remoteRoot)
                };
            } else if (!localChanged && remoteChanged) {
                await this.downloadRemote(relPath, remoteRoot);
                state[relPath] = { localMtime: Date.now(), remoteMtime };
            }
        }
    }

    private getLocalFiles(): { path: string; mtime: number }[] {
        const files = this.plugin.app.vault.getFiles();
        const patterns = this.plugin.settings.ignorePatterns
            .split("\n")
            .map(p => p.trim())
            .filter(p => p.length > 0);

        return files
            .filter(file => {
                const p = file.path;
                return !patterns.some(pat => {
                    if (pat.endsWith("/**")) {
                        const dir = pat.slice(0, -3);
                        return p.startsWith(dir);
                    }
                    if (pat.startsWith("*.")) {
                        const ext = pat.slice(1);
                        return p.endsWith(ext);
                    }
                    return p === pat;
                });
            })
            .map(file => ({
                path: file.path,
                mtime: file.stat.mtime,
            }));
    }

    private async uploadLocal(relPath: string, remoteRoot: string) {
        const vaultBasePath = (this.plugin.app.vault.adapter as any).getBasePath();
        const localFullPath = path.normalize(path.join(vaultBasePath, relPath));
        const remoteFullPath = remoteRoot + "/" + relPath;
        const remoteDir = path.dirname(remoteFullPath).replace(/\\/g, "/");
        
        // 先创建目标目录（自动递归）
        await this.client!.mkdir(remoteDir);
        // 再上传文件
        await this.client!.upload(localFullPath, remoteFullPath);
    }

    private async downloadRemote(relPath: string, remoteRoot: string) {
        const vaultBasePath = (this.plugin.app.vault.adapter as any).getBasePath();
        const localFullPath = path.normalize(path.join(vaultBasePath, relPath));
        const remoteFullPath = remoteRoot + "/" + relPath;
        // 确保本地目录存在（不过 Obsidian vault 应该已有）
        // 如果需要可以创建，这里跳过
        await this.client!.download(remoteFullPath, localFullPath);
    }

    private async deleteLocal(relPath: string) {
        const file = this.plugin.app.vault.getAbstractFileByPath(relPath);
        if (file) await this.plugin.app.vault.delete(file);
    }

    private async deleteRemote(relPath: string, remoteRoot: string) {
        const remoteFullPath = remoteRoot + "/" + relPath;
        await this.client!.delete(remoteFullPath);
    }

    private async getRemoteMtime(relPath: string, remoteRoot: string): Promise<number> {
        const files = await this.client!.listFiles(remoteRoot);
        const found = files.find(f => f.path === relPath);
        return found?.mtime ?? 0;
    }

    private async initClient() {
        const s = this.plugin.settings;
        if (s.syncMethod === "sftp") {
            this.client = new SftpClient({
                host: s.sftpHost,
                port: s.sftpPort,
                username: s.sftpUsername,
                password: s.sftpPassword,
            });
        } else {
            this.client = new WebdavClient({
                url: s.webdavUrl,
                username: s.webdavUsername,
                password: s.webdavPassword,
            });
        }
    }

    private async loadState(): Promise<SyncState> {
        const adapter = this.plugin.app.vault.adapter;
        if (await adapter.exists(this.statePath)) {
            const raw = await adapter.read(this.statePath);
            return JSON.parse(raw);
        }
        return {};
    }

    private async saveState(state: SyncState) {
        await this.plugin.app.vault.adapter.write(
            this.statePath,
            JSON.stringify(state, null, 2)
        );
    }
}