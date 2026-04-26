import { App, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import type BidirectionalSyncPlugin from "./main";
import { SftpClient } from "./sftp-client";
import { WebdavClient } from "./webdav-client";
import type { RemoteClient } from "./sync";

// 设置数据结构
export interface SyncSettings {
    syncMethod: "sftp" | "webdav";
    sftpHost: string;
    sftpPort: number;
    sftpUsername: string;
    sftpPassword: string;
    webdavUrl: string;
    webdavUsername: string;
    webdavPassword: string;
    remoteRoot: string;
    conflictPolicy: "newest" | "local" | "remote" | "ask";
    autoSyncInterval: number;
    ignorePatterns: string;
}

export type Settings = SyncSettings;

export const DEFAULT_SETTINGS: SyncSettings = {
    syncMethod: "webdav",
    sftpHost: "",
    sftpPort: 22,
    sftpUsername: "",
    sftpPassword: "",
    webdavUrl: "",
    webdavUsername: "",
    webdavPassword: "",
    remoteRoot: "/",
    conflictPolicy: "newest",
    autoSyncInterval: 0,
    ignorePatterns: ".obsidian/**\ntrash/**",
};

// ==================== 自定义浏览窗口（完全可控） ====================
class RemoteFolderBrowserModal extends Modal {
    client: RemoteClient;
    currentPath: string;
    onChoose: (path: string) => void;
    fileListEl: HTMLElement;
    pathDisplayEl: HTMLElement;

    constructor(
        app: App,
        client: RemoteClient,
        startPath: string,
        onChoose: (path: string) => void
    ) {
        super(app);
        this.client = client;
        this.currentPath = this.normalize(startPath);
        this.onChoose = onChoose;
    }

    private normalize(p: string): string {
        if (!p || p === "/") return "/";
        return "/" + p.replace(/^\/+/g, "").replace(/\/+$/g, "");
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("remote-folder-browser");

        // 当前路径显示
        this.pathDisplayEl = contentEl.createDiv({ cls: "browser-path" });
        this.pathDisplayEl.style.fontWeight = "bold";
        this.pathDisplayEl.style.marginBottom = "10px";

        // 文件列表容器
        this.fileListEl = contentEl.createDiv({ cls: "browser-list" });

        // 底部按钮
        const footer = contentEl.createDiv({ cls: "browser-footer" });
        footer.style.marginTop = "10px";
        footer.style.display = "flex";
        footer.style.justifyContent = "space-between";

        // 刷新按钮
        const refreshBtn = footer.createEl("button", { text: "🔄 刷新" });
        refreshBtn.addEventListener("click", () => this.refresh());

        // 选中当前文件夹
        const selectBtn = footer.createEl("button", {
            text: "✅ 选中当前文件夹",
            cls: "mod-cta",
        });
        selectBtn.addEventListener("click", () => {
            this.onChoose(this.currentPath);
            this.close();
        });

        // 加载文件列表
        await this.refresh();
    }

    async refresh() {
        this.pathDisplayEl.setText(`📂 当前目录：${this.currentPath}`);
        this.fileListEl.empty();
        this.fileListEl.createDiv({ text: "加载中...", cls: "loading" });

        try {
            const raw = await this.client.listFiles(this.currentPath);
            const allItems = Array.isArray(raw) ? raw : [];
            const folders = allItems
                .filter((item: any) => item.isCollection || item.path.endsWith("/"))
                .map((item: any) => item.path.replace(/\/$/, ""));

            this.fileListEl.empty();

            // 返回上级按钮（非根目录）
            if (this.currentPath !== "/") {
                const backRow = this.fileListEl.createDiv({ cls: "browser-item" });
                backRow.createSpan({ text: "📁 .." });
                const enterBtn = backRow.createEl("button", { text: "返回上级" });
                enterBtn.addEventListener("click", () => {
                    const parts = this.currentPath.split("/").filter(Boolean);
                    parts.pop();
                    this.currentPath = "/" + parts.join("/") || "/";
                    this.refresh();
                });
            }

            // 文件夹列表
            for (const folder of folders) {
                const row = this.fileListEl.createDiv({ cls: "browser-item" });
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.marginBottom = "4px";

                const nameSpan = row.createSpan({ text: `📁 ${folder}` });
                nameSpan.style.flexGrow = "1";

                // 进入子目录按钮
                const enterBtn = row.createEl("button", { text: "进入" });
                enterBtn.addEventListener("click", () => {
                    this.currentPath = this.normalize(this.currentPath + "/" + folder);
                    this.refresh();
                });

                // 直接选定按钮
                const selectBtn = row.createEl("button", { text: "选定" });
                selectBtn.style.marginLeft = "5px";
                selectBtn.addEventListener("click", () => {
                    const selectedPath = this.normalize(this.currentPath + "/" + folder);
                    this.onChoose(selectedPath);
                    this.close();
                });
            }

            if (folders.length === 0 && this.currentPath === "/") {
                this.fileListEl.createDiv({ text: "此目录为空" });
            }
        } catch (err) {
            this.fileListEl.empty();
            this.fileListEl.createDiv({ text: `⚠️ 无法访问：${err.message}` });
            // 保留返回按钮
            if (this.currentPath !== "/") {
                const backRow = this.fileListEl.createDiv({ cls: "browser-item" });
                backRow.createSpan({ text: "📁 .." });
                const enterBtn = backRow.createEl("button", { text: "返回上级" });
                enterBtn.addEventListener("click", () => {
                    const parts = this.currentPath.split("/").filter(Boolean);
                    parts.pop();
                    this.currentPath = "/" + parts.join("/") || "/";
                    this.refresh();
                });
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== 设置标签页 ====================
export class SyncSettingsTab extends PluginSettingTab {
    plugin: BidirectionalSyncPlugin;

    constructor(app: App, plugin: BidirectionalSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private createTempClient(): RemoteClient | null {
        const s = this.plugin.settings;
        if (s.syncMethod === "sftp") {
            if (!s.sftpHost) return null;
            return new SftpClient({
                host: s.sftpHost,
                port: s.sftpPort,
                username: s.sftpUsername,
                password: s.sftpPassword,
            });
        } else {
            if (!s.webdavUrl) return null;
            return new WebdavClient({
                url: s.webdavUrl,
                username: s.webdavUsername,
                password: s.webdavPassword,
            });
        }
    }

    private async browseRemotePath() {
        const client = this.createTempClient();
        if (!client) {
            new Notice("Please fill connection details first.");
            return;
        }
        try {
            await client.connect();
            let startPath = this.plugin.settings.remoteRoot;
            if (!startPath || startPath === "/") {
                startPath = "/";
            } else {
                startPath = "/" + startPath.replace(/^\/+|\/+$/g, "");
            }
            new RemoteFolderBrowserModal(
                this.app,
                client,
                startPath,
                (selectedPath) => {
                    this.plugin.settings.remoteRoot = selectedPath;
                    this.plugin.saveSettings();
                    this.display();
                }
            ).open();
        } catch (err) {
            new Notice("Connection failed: " + err.message);
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        // 使用说明区域（适配所有主题，排版清晰）
        const helpDiv = containerEl.createDiv("sync-help");
        helpDiv.style.borderRadius = "6px";
        helpDiv.style.padding = "12px";
        helpDiv.style.marginBottom = "16px";
        helpDiv.style.backgroundColor = "var(--background-secondary)";
        helpDiv.style.border = "1px solid var(--background-modifier-border)";

        const heading = helpDiv.createEl("h3", { text: "📚 使用说明" });
        heading.style.color = "var(--text-normal)";
        heading.style.marginTop = "0";

        const ol = helpDiv.createEl("ol");
        ol.style.color = "var(--text-muted)";
        ol.style.paddingLeft = "20px";
        ol.style.margin = "4px 0";

        const steps = [
            "选择协议（SFTP/WebDAV），填写连接信息。",
            "点击「Browse…」浏览远程目录。使用「进入」查看子目录，「选定」直接选择某文件夹，或用底部按钮「✅ 选中当前文件夹」选择当前目录。",
            "设置冲突策略与忽略规则（可选）。",
            "通过命令面板（Ctrl+P）执行「Sync vault now」手动同步，或设置自动同步间隔。",
            "同步状态保存在 .sync-state.json，请勿手动修改。"
        ];

        for (const step of steps) {
            const li = ol.createEl("li");
            li.setText(step);
            li.style.marginBottom = "4px";
        }

        // 同步方式
        new Setting(containerEl)
            .setName("Sync method")
            .setDesc("Choose SFTP or WebDAV")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("sftp", "SFTP")
                    .addOption("webdav", "WebDAV")
                    .setValue(this.plugin.settings.syncMethod)
                    .onChange(async (value: string) => {
                        this.plugin.settings.syncMethod = value as "sftp" | "webdav";
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.syncMethod === "sftp") {
            new Setting(containerEl).setName("Host").addText(text =>
                text.setValue(this.plugin.settings.sftpHost).onChange(async v => {
                    this.plugin.settings.sftpHost = v;
                    await this.plugin.saveSettings();
                })
            );
            new Setting(containerEl).setName("Port").addText(text =>
                text
                    .setValue(String(this.plugin.settings.sftpPort))
                    .onChange(async v => {
                        this.plugin.settings.sftpPort = Number(v) || 22;
                        await this.plugin.saveSettings();
                    })
            );
            new Setting(containerEl).setName("Username").addText(text =>
                text.setValue(this.plugin.settings.sftpUsername).onChange(async v => {
                    this.plugin.settings.sftpUsername = v;
                    await this.plugin.saveSettings();
                })
            );
            new Setting(containerEl).setName("Password").addText(text =>
                text
                    .setValue(this.plugin.settings.sftpPassword)
                    .onChange(async v => {
                        this.plugin.settings.sftpPassword = v;
                        await this.plugin.saveSettings();
                    })
                    .inputEl.type = "password"
            );
        } else {
            new Setting(containerEl).setName("WebDAV URL").addText(text =>
                text.setValue(this.plugin.settings.webdavUrl).onChange(async v => {
                    this.plugin.settings.webdavUrl = v;
                    await this.plugin.saveSettings();
                })
            );
            new Setting(containerEl).setName("Username").addText(text =>
                text.setValue(this.plugin.settings.webdavUsername).onChange(async v => {
                    this.plugin.settings.webdavUsername = v;
                    await this.plugin.saveSettings();
                })
            );
            new Setting(containerEl).setName("Password").addText(text =>
                text
                    .setValue(this.plugin.settings.webdavPassword)
                    .onChange(async v => {
                        this.plugin.settings.webdavPassword = v;
                        await this.plugin.saveSettings();
                    })
                    .inputEl.type = "password"
            );
        }

        // Remote root path + Browse 按钮
        new Setting(containerEl)
            .setName("Remote root path")
            .setDesc("Folder on the remote to sync with vault root")
            .addText(text =>
                text
                    .setValue(this.plugin.settings.remoteRoot)
                    .onChange(async v => {
                        this.plugin.settings.remoteRoot = v;
                        await this.plugin.saveSettings();
                    })
            )
            .addButton(btn =>
                btn
                    .setButtonText("Browse…")
                    .onClick(() => this.browseRemotePath())
            );

        // 冲突策略
        new Setting(containerEl)
            .setName("Conflict resolution")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("newest", "Keep newest")
                    .addOption("local", "Always keep local")
                    .addOption("remote", "Always keep remote")
                    .addOption("ask", "Ask every time (not implemented yet)")
                    .setValue(this.plugin.settings.conflictPolicy)
                    .onChange(async (value: string) => {
                        this.plugin.settings.conflictPolicy = value as SyncSettings["conflictPolicy"];
                        await this.plugin.saveSettings();
                    })
            );

        // 自动同步间隔
        new Setting(containerEl)
            .setName("Auto sync interval (seconds)")
            .setDesc("0 to disable")
            .addText(text =>
                text
                    .setValue(String(this.plugin.settings.autoSyncInterval))
                    .onChange(async v => {
                        this.plugin.settings.autoSyncInterval = Math.max(0, Number(v) || 0);
                        await this.plugin.saveSettings();
                    })
            );

        // 忽略模式
        new Setting(containerEl)
            .setName("Ignore patterns")
            .setDesc("Glob patterns (one per line), e.g. .obsidian/**")
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.ignorePatterns)
                    .onChange(async v => {
                        this.plugin.settings.ignorePatterns = v;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.cols = 30;
            });
    }
}
