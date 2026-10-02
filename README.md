# 证件水印 · ZJSY

给证件照片注明用途、有效期和签名的免费开源网站。照片和输入只在浏览器内存中处理，没有上传接口、数据库、Cookie、浏览器持久化存储或分析脚本。

**在线使用：[zjsy.zhtianqi.cn](https://zjsy.zhtianqi.cn)**  
**源码：[tqluffy/zjsy](https://github.com/tqluffy/zjsy)**

## 功能

- 选择、拖入或粘贴本地照片；提供不含真实个人信息的合成示例。
- 自定义多行用途声明、有效期、签名。
- 调节不透明度、密度、字号、角度、颜色、字体、描边和水平／垂直偏移。
- 每组水印独立的位置、角度、不透明度扰动；支持关闭扰动或重新随机。
- 使用稳定随机种子，缩放预览与原始尺寸导出的水印排列保持一致。
- 白边向原图外扩展，上侧使用明显字体完整标注用途及其他信息。
- 骑缝水印跨越原图与白边的四周接缝。
- 按住对比、用途与样式预设、过期日期提示、清除照片、恢复默认。
- PNG 无损导出或可调质量的 JPG 导出；重新编码，不复制原照片 EXIF 元数据。
- 响应式布局、键盘操作、表单标签、动态状态提示。

水印能明确用途并增加误用、复用的成本，但不能保证防止盗用或 AI 去水印。接收方可能对水印、白边与二维码有要求，提交前应检查实际导出文件。

## 隐私边界

浏览器读取用户主动选择的本地文件，Canvas 在内存中完成绘图，生成的 Blob 仅供用户主动下载。照片、文件名、用途、有效期、签名和水印参数都不发送到服务器。

- 不调用 fetch、XMLHttpRequest、WebSocket、sendBeacon 或远程图片处理服务。
- 不使用 localStorage、sessionStorage、IndexedDB、Cookie 或 Service Worker。
- JavaScript、CSS、图标都来自本站，没有外部字体、CDN 或第三方脚本。
- 部署设置 CSP，其中 connect-src 'none' 阻止页面脚本发起网络连接，form-action 'none' 阻止表单提交。
- 清除、更换照片和离开页面时释放图像引用；临时 Object URL 使用后撤销。
- 原图以浏览器解码后的视觉方向绘制，导出保留其原始像素尺寸；启用白边时增加画布尺寸。
- 支持静态 JPG、PNG、WebP、AVIF，文件最多 30 MB，2400 万像素、单边最多 14000 px；导出画布最多 4000 万像素、单边 16384 px，以降低内存耗尽风险。

托管平台仍会接收打开网页所必需的静态资源请求，可能按其政策处理常规访问日志；这些请求不包含照片和输入信息。下载是用户主动将生成文件保存到本机的行为。浏览器和操作系统如何管理内存，不属于网页可控制的范围。

## 本地开发

依赖 Node.js 22 或以上版本，以及**全局安装的 Wrangler**。项目没有运行时依赖，也无需安装前端依赖。

    git clone https://github.com/tqluffy/zjsy.git
    cd zjsy
    npm run dev

开发服务器由 Wrangler 提供。修改 src 后重新运行 npm run build 即可更新静态文件。npm run check 检查 JavaScript 语法。

## 部署及源码同步

配置位于 wrangler.jsonc，采用 Cloudflare Workers 静态资源与自定义域名。自部署时修改 account_id、name 和 routes。首次部署需要相应域名所属 Cloudflare 账号的权限。

    wrangler login --browser=false
    git add .
    git commit -m "Describe the change"
    npm run deploy

npm run deploy 依次执行：

1. 确认工作区干净、位于 main，origin 指向 tqluffy/zjsy。
2. 推送 main 至 GitHub，确认远端提交与本地 HEAD 相同。
3. 从该提交构建静态资源，将完整提交号写入 build.json 和页面版本链接。
4. 调用全局 wrangler deploy，将提交号记录为版本标签和部署说明。

网站页脚链接到对应源码提交，/build.json 可用于核对线上版本。GitHub 推送成功但 Cloudflare 部署失败时，脚本会报错；解决部署问题后重新执行 npm run deploy 即可。该流程不向 GitHub 保存 Cloudflare 的 OAuth 凭据，也不会在未提交或未推送的代码上部署。

维护者应通过 npm run deploy 发布。单独推送 GitHub 不会自动改变线上网站；直接调用 wrangler deploy 会绕过源码同步检查。fork 仓库需修改 scripts/release.mjs 中的目标仓库校验。

### WSL 无浏览器授权

使用 wrangler login --browser=false，将它输出的授权链接复制到 Windows 浏览器。回调为 http://localhost:8976/oauth/callback。WSL 的 localhost 转发需可用；浏览器在其他设备时可用 SSH 将该设备的 8976 端口转发到 Ubuntu。浏览器显示成功后，等待 Wrangler 保存凭据，并运行 wrangler whoami 确认。不要提交凭据文件或将访问令牌贴入公开讨论。

如果 D 盘挂载的文件所有权导致 Git chmod 失败，可将 Git 元数据放在 Linux 文件系统、通过 .git 指针文件连接工作区。这是本机配置，不影响 GitHub 仓库或正常克隆。

## 文件结构

- src/index.html：页面和表单语义。
- src/styles.css：响应式界面。
- src/app.js：内存中的文件生命周期、控件和导出。
- src/render.js：统一的水印、白边、骑缝绘制算法。
- src/_headers：隐私与安全响应头。
- scripts/build.mjs：零依赖构建与源码版本标识。
- scripts/release.mjs：GitHub 与 Cloudflare 同一源码提交的发布流程。
- wrangler.jsonc：静态资源托管与域名配置。

## 许可

[MIT](LICENSE) · Copyright 2026 tqluffy
