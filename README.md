# 证件水印 · ZJSY

免费、开源的证件照片水印工具。照片在浏览器内存中处理。可选的本站来源验证使用数字签名：二维码明文包含水印声明和两个签名摘要；照片内容与水印文字都不会发送给签名服务。

**[在线制作](https://zjsy.zhtianqi.cn) · [本地验证](https://zjsy.zhtianqi.cn/verify/) · [源码](https://github.com/tqluffy/zjsy)**

## 功能

- 选择、拖入或粘贴照片，支持合成示例。
- 用途、有效期、署名，以及不透明度、密度、字体、字号、角度、颜色、描边和偏移。
- 随机扰动与重新随机，预览和导出保持相同排列。
- 向外扩展的白边、明显用途声明和骑缝水印；白边左上角显示本站 Logo、地址和网站二维码。
- 可选本站来源验证：白边下方增加中心带 Logo 的签名二维码，主体四角增加定位块，不使用隐写。
- PNG 无损或 JPG 导出，不复制原照片 EXIF 元数据；可选导出尺寸。
- 移动端按实际预览区域绘制，合并滑块更新；触屏默认最大长边 2048 px，可切换原始尺寸。

水印增加复用成本，不保证防止盗用或 AI 去水印。提交前确认接收方对水印、白边及二维码的要求。

## 来源验证

开启白边后勾选“本站来源验证”。白边上方左侧始终有指向网站首页的二维码；启用验证后，底部增加中心带 Logo 的签名二维码。签名二维码包含水印文字和它的签名摘要、图像主体感知指纹和它的签名、公开的密钥 ID。扫描即可在本地核验签名水印文字；选择图像后，浏览器先确认四角定位块，再只对原图主体区域核对指纹。

水印文字由用途、可选有效期和可选署名组成，按二维码显示的换行连接。浏览器计算 `SHA-256(水印文字 + https://zjsy.zhtianqi.cn)`。图像摘要绑定画布尺寸、主体矩形、定位块尺寸，以及 32×32 主体图像的 pHash、dHash 和粗粒度色度特征。使用感知指纹可容忍轻微压缩失真；二维码仍签署指纹摘要，签名接口只收到水印与图像的两个摘要，不接收水印文字或图像像素。

二维码使用 `/verify/#p=...`，验证数据在 URL 片段中，不随网页请求发送。扫码后，页面先本地核验水印文字；完整图像选择后本地确认定位块并核对主体。pHash 差异不超过 18/256、dHash 差异不超过 8/64，且色度特征差异在阈值内时视为轻微失真容差内匹配。验证结果会显示定位与感知特征的匹配置信度分值；它不是图像真实性概率。裁切、非等比变形、定位块缺失或主体差异较大时会失败；容差匹配不代表每个像素完全相同。

| 结果 | 含义 |
| --- | --- |
| 水印签名通过 | 二维码中的水印文字摘要与可信公钥对应的本站签名有效 |
| 图像主体一致 | 感知指纹与二维码签名指纹一致 |
| 轻微失真容差内匹配 | 感知指纹差异在设定阈值内，可能经历压缩或等比缩放 |
| 图像主体核对未通过 | 定位块、图像比例、感知指纹或签名不匹配 |

签名证明签名服务为摘要生成了签名，不证明证件真实、署名者身份或网页执行过程。签名接口公开，任何人都可以请求签署摘要。旧版隐写凭据和旧版二维码格式不再兼容。

## 隐私

- 照片读取、绘制、预览、二维码生成和核验都在设备上进行。
- 普通导出不调用签名接口；启用验证时仅 POST 两个 SHA-256 摘要。
- 签名接口不记录请求正文，不保存摘要，也不使用数据库、KV 或 R2；私钥仅保存在 Cloudflare Secret。
- 不用 Cookie、localStorage、sessionStorage、IndexedDB 或 Service Worker 保存照片与设置。
- 无追踪、远程字体或二维码服务。验证页面 CSP 禁止数据连接。
- 清除、换图或离开页面时释放图像引用，撤销临时 Object URL。

托管平台会处理必要的网络请求，可能按其政策处理常规连接日志；应用不保存请求正文。下载是主动保存文件。外部浏览器、扫码软件和操作系统的历史与内存管理超出网页控制范围。

## 开发

需要 Node.js 22 或以上版本。网页和签名 Worker 无运行时包依赖；二维码源码随仓库提供。

    git clone https://github.com/tqluffy/zjsy.git
    cd zjsy
    npm run check
    npm run build
    npx wrangler@4.145.0 dev

修改 `src` 后重新构建。普通水印开发不需要私钥；调试签名时在未提交的 `.dev.vars` 中配置 `ZJSY_SIGNING_KEYS`，不要提交该文件。

## 部署

修改 `wrangler.jsonc` 的 `name`、`account_id` 和 `routes`，以及 `src/proof.js` 中的 `VERIFY_URL`、`VERIFY_ORIGIN` 和 `worker/signing.js` 中的 `DEFAULT_ORIGIN`，为自己的站点配置来源。

升级现有部署前，先按“密钥设置与轮换”创建并上传 `ZJSY_SIGNING_KEYS`，再发布新 Worker。新接口不读取旧的单密钥变量。

    npx wrangler@4.145.0 login
    npm run build
    npx wrangler@4.145.0 deploy

### 密钥设置与轮换

    node scripts/generate-signing-key.mjs /secure/path/signing-keys.json
    npx wrangler@4.145.0 secret put ZJSY_SIGNING_KEYS < /secure/path/signing-keys.json

密钥清单是 Cloudflare Secret JSON，格式为 `{"activeKeyId":"<公开 ID>","keys":{"<公开 ID>":"<Base64 PKCS#8 私钥>"}}`。生成脚本将私钥写入仓库外的清单，并把新公钥加入 `src/verification-keys.js`。轮换时更新 Cloudflare Secret；旧公钥会继续留在验证页，以核验历史新版二维码。Cloudflare 单个变量上限为 5 KB，因此脚本在密钥清单接近上限时会删除旧私钥条目；历史二维码验证只依赖浏览器中的旧公钥。密钥 ID 是公开值，私钥不得加入普通变量或提交到 GitHub。[Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

发布新公钥后再部署 Worker 和网页。若私钥泄露，应从可信公钥列表撤销对应 ID；这会同时使使用该公钥的二维码无法通过签名核验。

### GitHub 自动部署

Cloudflare Worker → Settings → Builds → Connect，连接自己的 GitHub 仓库：

| 设置 | 值 |
| --- | --- |
| 生产分支 | main |
| 根目录 | / |
| 构建命令 | npm run check && npm run build |
| 部署命令 | npx wrangler@4.145.0 deploy |
| 构建令牌 | 由 Cloudflare 管理 |

推送 main 后自动构建。确认成功并核对网站 `/build.json` 的 revision 与提交一致。网页页脚链接到对应源码，构建失败时保留上一个成功版本。

可选的 `npm run deploy` 是本仓库维护者的发布脚本，会检查干净工作区、main 和目标远端，再推送部署；自动构建直接运行 Wrangler。fork 后按自己的策略调整该脚本。

官方说明：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[Secret 变量](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 目录与许可

- `src/app.js`、`render.js`：编辑与绘图。
- `src/proof.js`：二维码、摘要生成和本地核验。
- `src/verification-keys.js`：可信公钥。
- `src/verify/`：本地验证页。
- `worker/signing.js`：无状态摘要签名接口。
- `scripts/`：构建、检查、密钥生成和发布。

[MIT](LICENSE) · Copyright 2026 tqluffy。二维码库分别保留许可，见 [第三方许可](src/vendor/NOTICE.md)。
