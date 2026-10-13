# GitHub 上传完整教程（Windows）

> 目标：把这个扩展（`st-rbq`）+ 配套预设推到 GitHub，让别人也能下载使用。
> 全程两条路：**A. 网页上传（最省事，推荐新手）** / **B. Git 命令（以后好更新）**。

---

## 先把要上传的东西准备好

### 1) 确认目录长这样

```
你要上传的文件夹（假设叫 st-rbq）
├─ manifest.json
├─ README.md            ← 我已经给你写好了
├─ LICENSE              ← 见下面「附：LICENSE 内容」
├─ .gitignore           ← 见下面「附：.gitignore 内容」
├─ boot-v2930.js
├─ index.js
├─ core/  ui/  data/  prompts/  tools/
└─ presets/             ← ⭐ 预设和世界书都在这里，一起上传
   ├─ index.json
   ├─ 斯拉RBQ-零.json
   └─ RBQ世界书.json
```

> **预设放哪？** 就放在扩展目录里的 **`presets/`** 文件夹（和 `manifest.json` 同级）。
> 好处：扩展的「设置 → 一键导入预设」会直接读它；别人 clone 下来一份就同时拿到**扩展 + 预设 + 世界书**。

### 2) 两个可选但建议加的文件

**`.gitignore`**（放仓库根目录，避免把垃圾提交上去）：

```gitignore
# 依赖 / 构建产物
node_modules/
dist/
*.log

# 编辑器 / 系统
.vscode/
.idea/
Thumbs.db
desktop.ini
.DS_Store

# 本地临时
*.tmp
*.bak
```

**`LICENSE`**（MIT，把 `<你的名字>` 改成你的署名 / 年份）：

```text
MIT License

Copyright (c) 2026 <你的名字>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 路线 A：网页上传（不用装任何东西）

### 第 1 步：注册 / 登录 GitHub

打开 https://github.com → 右上角 `Sign up`（没有账号）或 `Sign in`。

### 第 2 步：新建仓库

1. 右上角 **`+`** → **`New repository`**
2. 填写：
   - **Repository name**：`st-rbq`（或 `rbq-database`，英文/拼音都行）
   - **Description**：`SillyTavern 扩展：表格数据库 + 侧路填表 + 长期记忆 + 沉浸式视图`
   - **Public**（公开，别人才能下载）/ Private（私有）
   - **不要**勾 `Add a README file`（你已经有 README 了）
   - **不要**勾 `.gitignore` / `license`（你会自己传）
3. 点 **`Create repository`**

### 第 3 步：上传文件

1. 新仓库页面会有 **`uploading an existing file`** 链接 → 点它
   （或者点 `Add file` → `Upload files`）
2. 把 **`st-rbq` 文件夹里面的所有内容**（不是文件夹本身！）拖进上传区
   - ⚠️ 要拖 **文件 + 子文件夹**（`core`、`ui`、`presets` 等要一起进去）
   - ⚠️ 别只拖最外层文件夹，否则仓库里会多一层同名目录
3. 等上传完成（`presets/` 里两个大文件约 600 KB，很快）
4. 底部 **Commit changes** 里写一句：`首次提交：RBQ 数据库 v2.9.3`
5. 点 **`Commit changes`**

### 第 4 步：检查

- 仓库首页应该能看到 `README.md` 被渲染出来（带标题、徽章、截图位）
- 点进 `presets/` 应该能看到 `斯拉RBQ-零.json` 和 `RBQ世界书.json`
- 如果 README 没显示 → 说明文件名大小写不对（必须是 `README.md`）

---

## 路线 B：Git 命令（推荐，以后更新方便）

### 第 1 步：装 Git

下载 https://git-scm.com/download/win → 一路默认安装。
装完打开 **Git Bash** 或 **PowerShell**，验证：

```bash
git --version
```

### 第 2 步：配置身份（只需一次）

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"
```

### 第 3 步：在 GitHub 建仓库

同路线 A 的第 2 步（建好后**不要**初始化 README）。

### 第 4 步：本地初始化并推送

打开终端，`cd` 到 `st-rbq` 文件夹**的上一层**，然后：

```bash
cd D:\你的路径\st-rbq

git init
git add .
git commit -m "首次提交：RBQ 数据库 v2.9.3"
git branch -M main

# 把下面的 <你的用户名> 换成你的 GitHub 用户名
git remote add origin https://github.com/<你的用户名>/st-rbq.git
git push -u origin main
```

推送时会要求登录：
- **推荐**：用 **Personal Access Token** 当密码
  （GitHub → 头像 → `Settings` → `Developer settings` → `Personal access tokens` → `Tokens (classic)` → `Generate new token` → 勾 `repo` → 复制那串 token，**推送时贴到密码位置**）
- 或者装 **GitHub Desktop** 用它登录（更省事）

### 第 5 步：以后怎么更新

```bash
git add .
git commit -m "修了什么（一句话）"
git push
```

想发版本就在 GitHub 上：`Releases` → `Draft a new release` → Tag 写 `v2.9.3` → 附上打包的 zip。

---

## 常见问题

**Q：上传后别人怎么安装？**
他们只要把仓库 clone / 下载成文件夹，整个放进
`SillyTavern/data/default-user/extensions/` 即可（README 里已经写了）。

**Q：预设文件太大（420 KB）会被拒吗？**
不会。GitHub 单文件上限 100 MB，超过 50 MB 才会警告。

**Q：我不想让别人改，只想发布？**
仓库设成 `Public` 也能接受别人的 Pull Request，你有权拒绝；
想完全禁止就在 `Settings → General → Features` 里关掉 `Issues` / `Pull requests`。

**Q：怎么让仓库看起来专业一点？**
- 加上 `LICENSE`（本文开头有模板）
- 在 `Settings → General → Social preview` 传一张截图
- 用 `Releases` 发布每个版本的 zip
- README 里插入几张截图（见下）

**Q：README 里想放截图怎么办？**
1. 在仓库里新建 `docs/` 目录，把图片传上去（`Add file → Upload files`）
2. README 里写：

```markdown
![仪表盘](docs/panel.png)
![角色卡](docs/character-card.png)
```

---

## 附：一条命令打包 zip（发布 Releases 用）

在 `st-rbq` **的上一层**执行（PowerShell）：

```powershell
Compress-Archive -Path .\st-rbq\* -DestinationPath .\st-rbq-v2.9.3.zip -Force
```

然后把这个 zip 拖到 GitHub 的 `Releases` 页面即可。
