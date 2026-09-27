# box

个人项目集合仓库。每个子目录是一个独立、自包含的项目，克隆后即可直接使用，互不依赖。

## 项目列表

| 项目 | 说明 |
| --- | --- |
| [apng-maker](./apng-maker) | 浏览器端 APNG 制作器：把多张图片合成为一张 APNG 动图 |

## 目录结构

```
box/
├── README.md          # 本文件
├── .gitignore         # 忽略 OS / 编辑器 / 依赖 / 日志类文件
└── apng-maker/        # 项目：APNG 制作器
    ├── index.html     # 页面结构
    ├── style.css      # 全部样式
    ├── render.js      # 帧几何与画面合成
    ├── apng.js        # APNG 编码器
    ├── app.js         # 状态、交互、预览与导出
    └── README.md      # 项目详细说明
```

## apng-maker

把若干张图片合成为一张 **APNG 动图**。纯静态、零依赖、零构建，全部在浏览器本地完成，**图片不会上传到任何地方**。

形态与交互参照 [GlassSky01/Gifer](https://github.com/GlassSky01/Gifer)（Gifer 输出 GIF，本项目输出 APNG）。

### 使用方法

1. 双击 `apng-maker/index.html` 打开（只保证 Chrome / Edge）
2. 点「添加图片」选图，也可以把图片拖到左侧列表，或直接 `Ctrl+V` 粘贴
3. 拖拽缩略图调整顺序，悬停点 `×` 移除
4. 选合成模式（**扫描线擦除** / **普通逐帧**）、调参数，右侧「实时预览」直接看效果
5. 点「导出 .apng」下载

不需要服务器、不需要安装任何东西、不需要联网。刷新即清空，不留任何数据。

参数、自动降级策略与 APNG 编码实现要点详见 [apng-maker/README.md](./apng-maker/README.md)。

## 克隆仓库

```
git clone https://github.com/LuXingChuan01/box.git
```

克隆后直接双击对应项目目录下的 `index.html` 即可运行，无需安装依赖、无需构建步骤。
