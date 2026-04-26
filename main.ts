import { Plugin, Notice, TFile, TFolder } from "obsidian";
import { Settings, DEFAULT_SETTINGS, SyncSettingsTab } from "./settings";
import { SyncManager } from "./sync";

export default class BidirectionalSyncPlugin extends Plugin {
  settings: Settings;
  syncManager: SyncManager;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(this);

    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.syncManager.fullSync(),
    });

    // 定时自动同步
    if (this.settings.autoSyncInterval > 0) {
      this.registerInterval(
        window.setInterval(() => {
          this.syncManager.fullSync();
        }, this.settings.autoSyncInterval * 1000)
      );
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}