# 证件水印 · ZJSY

免费、开源的证件照片水印工具。照片在浏览器内存中处理，不上传或保存照片。可选的本站来源验证仅向签名接口发送 SHA-256 摘要，不发送照片、用途、有效期或署名的原始内容。

**[在线制作](https://zjsy.zhtianqi.cn) · [本地验证](https://zjsy.zhtianqi.cn/verify/) · [源码](https://github.com/tqluffy/zjsy)**

## 功能

- 选择、拖入或粘贴照片，支持合成示例。
- 用途、有效期、署名，以及不透明度、密度、字体、字号、角度、颜色、描边和偏移。
- 随机扰动与重新随机，预览和导出保持相同排列。
- 向外扩展的白边、明显用途声明和骑缝水印。
- 可选本站验证：主体分散隐写、白边 DCT 隐写、Reed–Solomon 纠错和已签名的二维码。
- PNG 无损或 JPG 导出，不复制原照片 EXIF 元数据；可选导出尺寸。
- 移动端按实际预览区域绘制，合并滑块更新；触屏默认最大长边 2048 px，可切换原始尺寸。

水印增加复用成本，不保证防止盗用或 AI 去水印。提交前确认接收方对水印、白边及二维码的要求。

## 来源验证

开启白边后勾选“本站来源验证”。二维码包含已签名的用途、有效期、署名、图像摘要和凭据，指向 /verify/。扫码后查看声明，再选择完整图像核对；也可直接在验证页选择图像。

二维码数据位于 URL 片段（# 后），不会随网页请求发送到服务器。验证页会清理当前页面历史条目的片段。信息随图像分享，扫码设备也可能记录网址。

| 结果 | 含义 |
| --- | --- |
| 本站签名与内容校验一致 | 签名有效，内容摘要一致；保留给隐写的蓝色最低位除外 |
| 本站签名有效、内容近似 | 经压缩或缩放后宏观特征近似，不能证明细节未被修改 |
| 内容不匹配或签名无效 | 信息被修改、主体被替换，或凭据不属于本站 |
| 凭据无法恢复 | 裁剪、严重压缩、二维码损坏等导致无法核对 |

主体隐写分散使用蓝色最低位，单个像素最多改变一个色阶；白边包含重复的低频 DCT 副本。RS(255,191) 每份副本理论上可纠正最多 32 个错误字节。严重压缩、裁剪、重拍或强缩小可能失败。

**PNG 适合严格核对。JPG 本身有损，生成时就可能进入近似核对。** 近似特征不是安全哈希，不能确认细微文字未被修改。

签名证明本站服务签发了该摘要，不证明证件真实或署名者身份。服务公开，不能保证调用者使用了未经修改的前端。详见 [验证协议与安全边界](docs/verification.md)。

## 隐私

- 照片的读取、绘制、隐写、二维码生成、解析及验证都在设备上进行。
- 普通导出不调用签名接口；验证开启时仅 POST /api/sign，正文只含 64 位十六进制摘要。
- 用途、有效期、署名和图像信息在本地组成签名数据，并在本地计算摘要。
- 签名接口不记录请求正文、不存储摘要或图像，不绑定数据库、KV、R2；私钥保存在 Cloudflare Secret。
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

修改 src 后重新构建。普通水印开发不需要私钥；调试签名时在未提交的 .dev.vars 中配置私钥与站点来源，不要提交该文件。

## 部署

修改 wrangler.jsonc 的 name、account_id、routes，以及 src/proof.js 的 VERIFY_URL、Worker 的 ZJSY_SITE_ORIGIN，为自己的站点生成独立密钥。

    npx wrangler@4.145.0 login
    npm run build
    npx wrangler@4.145.0 deploy

### 密钥设置与轮换

    node scripts/generate-signing-key.mjs /secure/path/private-key.txt
    npx wrangler@4.145.0 secret put ZJSY_SIGNING_PRIVATE_KEY < /secure/path/private-key.txt

脚本把公钥写入 src/verification-keys.js，私钥写入指定的仓库外文件。将输出的公钥 ID 设置为 wrangler.jsonc 的 ZJSY_SIGNING_KEY_ID，再构建部署。私钥使用 Secret，不应使用明文变量或提交到 GitHub。

轮换时新公钥会加入列表，旧公钥可保留以验证历史图像。私钥、KEY_ID 和公钥必须配套发布，切换期间服务可能暂不可用，客户端会阻止无效凭据导出。若旧私钥泄露，应撤销对应公钥。

### GitHub 自动部署

Cloudflare Worker → Settings → Builds → Connect，连接自己的 GitHub 仓库：

| 设置 | 值 |
| --- | --- |
| 生产分支 | main |
| 根目录 | / |
| 构建命令 | npm run check && npm run build |
| 部署命令 | npx wrangler@4.145.0 deploy |
| 构建令牌 | 由 Cloudflare 管理 |

推送 main 后自动构建。确认成功并核对网站 /build.json 的 revision 与提交一致。网页页脚链接到对应源码，构建失败时保留上一个成功版本。

可选的 npm run deploy 是本仓库维护者的发布脚本，会检查干净工作区、main 和目标远端，再推送部署；自动构建直接运行 Wrangler。fork 后按自己的策略调整该脚本。

官方说明：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[Secret 变量](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 目录与许可

- src/app.js、render.js：编辑与绘图。
- src/proof.js、ecc.js：凭据、二维码与隐写。
- src/verification-keys.js：可信公钥。
- src/verify/：本地验证页。
- worker/signing.js：无状态的摘要签名接口。
- scripts/：构建、检查、密钥生成和发布。

[MIT](LICENSE) · Copyright 2026 tqluffy。二维码库分别保留许可，见 [第三方许可](src/vendor/NOTICE.md)。
