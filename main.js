/* Vault Doctor —— 双链健康中心
 * 三类体检（全部基于 metadataCache，瞬时完成、无需自解析）：
 *   1. 坏链：unresolvedLinks —— 指向不存在笔记的链接（可一键创建目标笔记）
 *   2. 孤岛：无任何反链且未被嵌入的笔记（模板/忽略路径除外）
 *   3. 悬空附件：仓库里有、但没有任何笔记引用的附件（pdf/图片/音视频等）
 * 面板分组展示，点击跳转源文件；坏链可一键创建；支持忽略路径前缀。
 */
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, TFile, MarkdownView } = require("obsidian");

const VIEW_TYPE = "vault-doctor-view";
const ATTACH_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "pdf", "mp3", "wav", "ogg", "webm", "mp4", "mov", "m4a", "flac", "docx", "xlsx", "pptx", "zip"]);

const DEFAULT_SETTINGS = {
  ignorePaths: "模板, templates, 90-Assets", // 忽略的路径前缀（逗号分隔）
  ignoreTags: "", // 含这些 tag 的笔记跳过孤岛判定（逗号分隔）
};

module.exports = class VaultDoctor extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.result = null;

    this.addRibbonIcon("stethoscope", "Vault Doctor 双链体检", () => this.runScan());
    this.addCommand({ id: "scan", name: "全库体检（坏链/孤岛/悬空附件）", callback: () => this.runScan() });
    this.addSettingTab(new DoctorSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new DoctorView(leaf, this));
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  async saveSettings() { await this.saveData(this.settings); }

  ignoreList() { return this.settings.ignorePaths.split(",").map((s) => s.trim()).filter(Boolean); }
  isIgnored(path) { return this.ignoreList().some((p) => path.startsWith(p)); }

  async runScan() {
    const t0 = Date.now();
    const mdFiles = this.app.vault.getMarkdownFiles().filter((f) => f.extension === "md" && !this.isIgnored(f.path));
    const broken = {}; // 目标路径 -> [{src, count}]
    let brokenCount = 0;

    // 1) 坏链
    const unresolved = this.app.metadataCache.unresolvedLinks || {};
    for (const [src, targets] of Object.entries(unresolved)) {
      if (this.isIgnored(src)) continue;
      for (const [target, count] of Object.entries(targets)) {
        if (!count) continue;
        (broken[target] = broken[target] || []).push({ src, count });
        brokenCount += count;
      }
    }

    // 2) 孤岛（无反链 + 未被任何笔记嵌入 + 无忽略 tag）
    const ignoreTags = this.settings.ignoreTags.split(",").map((s) => s.trim()).filter(Boolean);
    const orphans = [];
    for (const f of mdFiles) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache) continue;
      const tags = new Set((cache.tags || []).map((t) => t.tag.replace(/^#/, "")));
      const fmTags = cache.frontmatter && Array.isArray(cache.frontmatter.tags) ? cache.frontmatter.tags : [];
      for (const t of fmTags) tags.add(String(t).replace(/^#/, ""));
      if (ignoreTags.some((t) => tags.has(t))) continue;
      const backlinks = this.app.metadataCache.getBacklinksForFile(f);
      if (backlinks && backlinks.size() > 0) continue;
      orphans.push(f);
    }

    // 3) 悬空附件：附件文件无任何反链指向（引用即反链）
    const dangling = [];
    const allFiles = this.app.vault.getFiles();
    for (const f of allFiles) {
      if (!ATTACH_EXTS.has(f.extension.toLowerCase())) continue;
      if (this.isIgnored(f.path)) continue;
      const bl = this.app.metadataCache.getBacklinksForFile(f);
      if (!bl || bl.size() === 0) dangling.push(f);
    }

    this.result = {
      broken, brokenCount, orphans, dangling,
      ms: Date.now() - t0,
      scanned: mdFiles.length,
    };

    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view && typeof leaf.view.render === "function") leaf.view.render();
  }

  /** 一键创建缺失笔记（放到与首个引用者相同的文件夹） */
  async createMissing(target) {
    const clean = target.replace(/#.*$/, "").replace(/\[\[/, "").trim();
    const referrer = (this.result.broken[target] || [])[0];
    let dir = "";
    if (referrer) {
      const srcFile = this.app.vault.getAbstractFileByPath(referrer.src);
      if (srcFile && srcFile.parent) dir = srcFile.parent.path;
    }
    const path = (dir ? dir + "/" : "") + clean + ".md";
    try {
      const f = await this.app.vault.create(path, "");
      new Notice("已创建：" + path);
      this.app.workspace.getLeaf("tab").openFile(f);
    } catch (e) {
      new Notice("创建失败（可能已存在）：" + e.message);
    }
  }
};

class DoctorView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Vault Doctor"; }
  getIcon() { return "stethoscope"; }

  async onOpen() { await this.render(); }
  onClose() { this.contentEl.empty(); }

  async render() {
    const { contentEl } = this;
    const plugin = this.plugin;
    const r = plugin.result;
    contentEl.empty();
    contentEl.createEl("h4", { text: "🩺 Vault Doctor 双链健康中心" });

    const scanBtn = contentEl.createEl("button", { text: "全库体检", cls: "mod-cta" });
    scanBtn.style.marginBottom = "8px";
    scanBtn.onclick = () => plugin.runScan();

    if (!r) {
      contentEl.createEl("div", { text: "点「全库体检」开始。", attr: { style: "color:var(--text-muted);" } });
      return;
    }

    // 总览
    const hero = contentEl.createDiv();
    hero.style.cssText = "display:flex; margin-bottom:8px; background:var(--background-secondary); border-radius:8px;";
    const cell = (label, val, color) => {
      const c = hero.createDiv();
      c.style.cssText = "flex:1; text-align:center; padding:6px 2px;";
      c.createEl("div", { text: String(val), attr: { style: `font-size:18px; font-weight:700; color:${color};` } });
      c.createEl("div", { text: label, attr: { style: "font-size:11px; color:var(--text-muted);" } });
    };
    const hasIssue = r.brokenCount > 0 || r.orphans.length > 0 || r.dangling.length > 0;
    cell("坏链", r.brokenCount, r.brokenCount ? "var(--text-error)" : "var(--text-success)");
    cell("孤岛笔记", r.orphans.length, r.orphans.length ? "var(--text-warning)" : "var(--text-success)");
    cell("悬空附件", r.dangling.length, r.dangling.length ? "var(--text-warning)" : "var(--text-success)");
    cell("体检耗时", r.ms + "ms");
    contentEl.createEl("div", {
      text: `已扫描 ${r.scanned} 篇笔记` + (hasIssue ? "" : " · ✅ 全库健康"),
      attr: { style: "font-size:11px; color:var(--text-muted); margin-bottom:8px;" },
    });

    // 坏链（可修复）
    const brokenEntries = Object.entries(r.broken).sort((a, b) => b[1].length - a[1].length);
    if (brokenEntries.length) {
      const sec = contentEl.createEl("details");
      sec.open = true;
      sec.createEl("summary", { text: `🔗 坏链目标 ${brokenEntries.length} 个（点击创建缺失笔记）`, attr: { style: "font-weight:600; color:var(--text-error); cursor:pointer;" } });
      for (const [target, refs] of brokenEntries) {
        const row = sec.createDiv();
        row.style.cssText = "display:flex; align-items:center; gap:6px; padding:3px 4px; border-bottom:1px solid var(--background-modifier-border); font-size:12px;";
        const txt = row.createDiv();
        txt.style.flex = "1";
        txt.createEl("div", { text: target, attr: { style: "font-weight:600;" } });
        txt.createEl("div", { text: `被 ${refs.length} 篇引用（${refs.reduce((s, x) => s + x.count, 0)} 处）｜ 首个来源：${refs[0].src}`, attr: { style: "color:var(--text-muted); font-size:11px;" } });
        const create = row.createEl("button", { text: "+创建", cls: "mod-cta" });
        create.style.padding = "2px 8px";
        create.onclick = () => plugin.createMissing(target);
        txt.getFirstChild && null;
        const srcLink = txt.children ? null : null;
        txt.addEventListener("click", async () => {
          const f = plugin.app.vault.getAbstractFileByPath(refs[0].src);
          if (f) {
            await plugin.app.workspace.getLeaf("tab").openFile(f);
          }
        });
        txt.style.cursor = "pointer";
        txt.title = "点击打开首个引用来源";
      }
    }

    // 孤岛
    if (r.orphans.length) {
      const sec = contentEl.createEl("details");
      sec.createEl("summary", { text: `🏝 孤岛笔记 ${r.orphans.length} 篇（无反链，可能需要互链或归档）`, attr: { style: "font-weight:600; color:var(--text-warning); cursor:pointer;" } });
      for (const f of r.orphans) {
        const row = sec.createDiv();
        row.style.cssText = "padding:2px 4px; font-size:12px; cursor:pointer;";
        row.setText(f.path);
        row.onclick = () => plugin.app.workspace.getLeaf("tab").openFile(f);
      }
    }

    // 悬空附件
    if (r.dangling.length) {
      const sec = contentEl.createEl("details");
      sec.createEl("summary", { text: `📎 悬空附件 ${r.dangling.length} 个（存在但无引用）`, attr: { style: "font-weight:600; color:var(--text-warning); cursor:pointer;" } });
      for (const f of r.dangling) {
        const row = sec.createDiv();
        row.style.cssText = "padding:2px 4px; font-size:12px; cursor:pointer;";
        row.setText(f.path);
        row.onclick = () => plugin.app.workspace.getLeaf("tab").openFile(f);
      }
    }
  }
}

class DoctorSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("忽略路径前缀")
      .setDesc("逗号分隔。这些路径下的文件不参与任何体检")
      .addText((t) => t.setValue(this.plugin.settings.ignorePaths).onChange(async (v) => {
        this.plugin.settings.ignorePaths = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("孤岛豁免标签")
      .setDesc("逗号分隔。笔记含这些 tag 时不判为孤岛（如模板、MOC）")
      .addText((t) => t.setValue(this.plugin.settings.ignoreTags).onChange(async (v) => {
        this.plugin.settings.ignoreTags = v; await this.plugin.saveSettings();
      }));
  }
}
